import { PATH_WGSL } from '../../paths/path_wgsl'
import type { Effects } from '../effects'
import {
  align,
  centroid,
  collapsed,
  MORPH_POINTS,
  type PathShape,
  resample
} from '../path_shapes'
import type { Transform } from '../transform'
import type { Transition } from '../transition'
import { type Morph, type MorphOptions, morph } from './morph'
import type { Shockwave } from './shockwave'

// Keyed layout morphs between two DOM states (M5d-2; docs/EFFECTS.md,
// Morph). Elements carrying `data-gpu-morph="key"` in both states are
// paired by key; each pair's box moves and resizes from its old place to
// its new one while the old element (cut from the held snapshot of the
// outgoing page) cross-fades into the new one (the live element, moved
// there by a layer transform, so its text and vectors stay crisp).
// Everything else cross-fades between the two pages. Progress 0 is the
// outgoing page exactly and 1 the incoming page exactly.
//
//   const m = layoutMorph(fx)
//   await m.capture()      // old boxes measured, the page held
//   swapTheDom()
//   await m.settled()      // the incoming mirror complete; pairs made
//   await m.play(700, ease) // or tween m.progress, then m.end()
//
// Cut-outs carry what was behind the old element (a page background
// moves with it); an old spot left behind shows the new page. A keyed
// element nested in another pairs on its own: inside its parent's
// cut-out, its old spot shows the new page. Pairs whose box is empty or
// more than a viewport off screen in either state cross-fade instead.
// Elements with a CSS transform pair by their bounding boxes. Under
// reduced motion nothing moves: the pages cross-fade (play() in 150 ms).
//
// A keyed svg drawn as vectors on both sides (data-gpu-morph opts it into
// the path pass) morphs its shapes instead (M5d-3): shapes pair by paint
// order and their subpaths by order, each resampled to MORPH_POINTS and
// aligned (winding direction, least-travel start); the pass fills and
// strokes the points in between, colours and stroke widths mixed, while
// the live svg is hidden. A shape or subpath on one side only grows from
// or shrinks to its centroid, fading.
//
// A keyed element whose text changed (an element that paints no box,
// its string different) morphs as glyph segments (presets/morph.ts):
// kept graphemes move whole, changed ones break into segments that
// re-form as the new string on the way to the new box. The morph's layer
// draws for the pass alone (Transition.addLayer), composited over the
// blend of the pages, so the text is never half faded; the live text is
// hidden in flight and the old text keyed out of the snapshot.

/** Pairs the pass can draw (more: the rest cross-fade, with a warning). */
export const MAX_PAIRS = 16

const KEY_ATTR = 'data-gpu-morph'

/** Shapes (svg paths) and their subpaths the pass morphs, all pairs
 * together; past them a pair cross-fades as a box. */
export const MAX_SHAPES = 16
export const MAX_CONTOURS = 24

const M = MORPH_POINTS

const table = { type: 'vec4', default: [0, 0, 0, 0], count: MAX_PAIRS } as const
const shapeTable = {
  type: 'vec4',
  default: [0, 0, 0, 0],
  count: MAX_SHAPES
} as const

const schema = {
  progress: { type: 'f32', default: 0, min: 0, max: 1 },
  count: { type: 'f32', default: 0 },
  // Per pair: old and new boxes (uv: x, y, w, h over the viewport); radii
  // (CSS px: old, new) and the kind (0 box, 1 text keyed out of the
  // snapshot by its colour, 2 svg shapes, 3 text morphing as segments);
  // the old text colour (sRGB, alpha).
  o: table,
  n: table,
  r: table,
  c: table,
  shapes: { type: 'f32', default: 0 },
  // Per shape: pair, first subpath, subpaths, even-odd; fill (f0 old, f1
  // new) and stroke (s0, s1) colours (sRGB, alpha; alpha 0 for none); stroke widths
  // (CSS px: old, new).
  sh: shapeTable,
  f0: shapeTable,
  f1: shapeTable,
  s0: shapeTable,
  s1: shapeTable,
  sw: shapeTable,
  // Per subpath: closed. Points: old x y, new x y; M per subpath.
  ct: { type: 'vec4', default: [0, 0, 0, 0], count: MAX_CONTOURS },
  pt: { type: 'vec4', default: [0, 0, 0, 0], count: MAX_CONTOURS * M }
} as const

export type LayoutMorphSchema = typeof schema

const FRAGMENT = /* wgsl */ `
${PATH_WGSL}
fn lm_o(i : u32) -> vec4f { return params.o[i]; }
fn lm_n(i : u32) -> vec4f { return params.n[i]; }
fn lm_r(i : u32) -> vec4f { return params.r[i]; }
fn lm_c(i : u32) -> vec4f { return params.c[i]; }

fn lm_in(uv : vec2f, r : vec4f) -> bool {
  return all(uv >= r.xy) && all(uv < r.xy + r.zw);
}

// Coverage of a rounded box (CSS px) at p, a pixel's ramp at the edge.
fn lm_cov(p : vec2f, r : vec4f, rad : f32) -> f32 {
  let h = r.zw * 0.5;
  let k = min(rad, min(h.x, h.y));
  let q = abs(p - (r.xy + h)) - (h - vec2f(k));
  let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - k;
  return clamp(0.5 - d, 0.0, 1.0);
}

// What was behind pair i's old text: the snapshot just outside its box's
// corners, averaged.
fn lm_bg(i : u32, css : vec2f) -> vec4f {
  let o = lm_o(i);
  let d = 3.0 / css;
  let a = o.xy - d;
  let b = o.xy + o.zw + d;
  return 0.25 * (prev(a) + prev(vec2f(b.x, a.y)) + prev(vec2f(a.x, b.y)) +
    prev(b));
}

// Pair i's old text at a snapshot pixel: its colour and the coverage
// that puts it over the background bg (exact for flat backgrounds).
fn lm_text(i : u32, px : vec4f, bg : vec4f) -> vec4f {
  let c = lm_c(i);
  let d = c.rgb - bg.rgb;
  let k = clamp(dot(px.rgb - bg.rgb, d) / max(dot(d, d), 1e-4), 0.0, 1.0);
  return vec4f(c.rgb * k, k);
}

// The snapshot pixel px with pair j's old text keyed out: its colour's
// share taken off (px = bg + k (c - bg), so px - k (c - bg) is what was
// behind it).
fn lm_unkey(j : u32, px : vec4f, css : vec2f) -> vec4f {
  let bg = lm_bg(j, css);
  let k = lm_text(j, px, bg).a;
  return px - k * (vec4f(lm_c(j).rgb, 1.0) - bg);
}

// The snapshot pixel px at uv q with every pair from "first" whose old box
// holds q taken out: text keyed off; an svg whose shapes morph replaced by
// what was around it (its background); a box replaced by fill (the new
// page; nothing after a box applies).
fn lm_holes(first : u32, n : u32, q : vec2f, px : vec4f, fill : vec4f,
    css : vec2f) -> vec4f {
  var o = px;
  for (var j = first; j < n; j++) {
    if (lm_in(q, lm_o(j))) {
      let k = lm_r(j).z;
      if (abs(k - 2.0) < 0.5) {
        o = lm_bg(j, css);
      } else if (k < 0.5) {
        return fill;
      } else {
        o = lm_unkey(j, o, css);
      }
    }
  }
  return o;
}

// Over col: pair i's shapes at t (p in CSS px, apx CSS px per device px).
fn lm_shapes(i : u32, p : vec2f, t : f32, apx : f32, col0 : vec4f) -> vec4f {
  var col = col0;
  let ns = min(u32(params.shapes), ${MAX_SHAPES}u);
  for (var s = 0u; s < ns; s++) {
    let h = params.sh[s];
    if (u32(h.x) != i) {
      continue;
    }
    let first = u32(h.y);
    let last = min(first + u32(h.z), ${MAX_CONTOURS}u);
    var wind = 0;
    var acc = vec3f(1e20);
    var ds = 1e20;
    for (var c = first; c < last; c++) {
      let base = c * ${M}u;
      let closed = params.ct[c].x > 0.5;
      let e = params.pt[base + ${M - 1}u];
      var v0 = mix(e.xy, e.zw, t);
      for (var j = 0u; j < ${M}u; j++) {
        let q = params.pt[base + j];
        let v1 = mix(q.xy, q.zw, t);
        wind += path_wind(p, v0, v1);
        acc = path_fill_acc(acc, p, v0, v1);
        if (j > 0u || closed) {
          ds = min(ds, path_seg_dist(p, v0, v1));
        }
        v0 = v1;
      }
    }
    let fc = mix(params.f0[s], params.f1[s], t);
    let fa = fc.a * clamp(path_fill_sd(wind, acc, h.w > 0.5) / apx + 0.5,
      0.0, 1.0);
    col = vec4f(fc.rgb * fa, fa) + col * (1.0 - fa);
    let w = params.sw[s];
    let sc = mix(params.s0[s], params.s1[s], t);
    let sa = sc.a * clamp((0.5 * mix(w.x, w.y, t) - ds) / apx + 0.5, 0.0,
      1.0);
    col = vec4f(sc.rgb * sa, sa) + col * (1.0 - sa);
  }
  return col;
}

fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  let t = clamp(params.progress, 0.0, 1.0);
  // Exact at either end (mix may round).
  if (t <= 0.0) {
    return prev(uv);
  }
  if (t >= 1.0) {
    return sample(uv);
  }
  let css = fx.viewport / fx.dpr;
  let p = uv * css;
  let live = sample(uv);
  let n = min(u32(params.count), ${MAX_PAIRS}u);
  // The outgoing page with the pairs' old elements taken out (they
  // travel on their own).
  let old = lm_holes(0u, n, uv, prev(uv), live, css);
  var col = mix(old, live, t);
  // Pairs in DOM order (a nested pair after its parent, so on top).
  for (var i = 0u; i < n; i++) {
    let o = lm_o(i);
    let r = o * (1.0 - t) + lm_n(i) * t;
    let rr = lm_r(i);
    let cov = lm_cov(p, r * vec4f(css, css), rr.x * (1.0 - t) + rr.y * t);
    if (rr.z > 2.5) {
      // Text morphing as segments: drawn by its layer (the overlay).
      continue;
    }
    if (rr.z > 1.5) {
      // Svg shapes, drawn here (the live svg is hidden in flight); only
      // near the box between (shapes stay inside their svg's box, with
      // room for strokes past it).
      let g = r * vec4f(css, css) + vec4f(-16.0, -16.0, 32.0, 32.0);
      if (lm_in(p, g)) {
        col = lm_shapes(i, p, t, 1.0 / fx.dpr, col);
      }
    } else if (cov > 0.0) {
      // The same point of the old box: the old element, moved.
      let q = o.xy + (uv - r.xy) * o.zw / max(r.zw, vec2f(1e-6));
      let po = prev(q);
      if (rr.z > 0.5) {
        // Text: the old glyphs alone, fading over what is there (the new
        // text fades in with the page).
        let ot = lm_text(i, po, lm_bg(i, css)) * (1.0 - t) * cov;
        col = ot + col * (1.0 - ot.a);
      } else {
        let pk = lm_holes(i + 1u, n, q, po, live, css);
        col = mix(col, mix(pk, live, t), cov);
      }
    }
  }
  // Text morphs, whole over the blend.
  let ov = overlay(uv);
  return ov + col * (1.0 - ov.a);
}
`

/** A keyed element as captured. */
interface Old {
  box: Box
  radius: number
  /** Paints no box: drawn by keying its text colour out of the snapshot. */
  text: boolean
  /** Its text colour, sRGB 0..1 with alpha. */
  color: number[]
  /** A vector svg's shapes, viewport CSS px; empty otherwise. */
  shapes: PathShape[]
  /** Its text (text-only elements), and the morph holding a copy. */
  string: string
  morph: Morph | null
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface Pair {
  key: string
  el: Element
  old: Box
  now: Box
  /** The new border box's top-left: the transform's origin. */
  org: { x: number; y: number }
  /** Index of the nearest paired ancestor, or -1. */
  parent: number
  tf: Transform | null
  /** Its svg shapes morph (the live svg hidden in flight). */
  shapes: boolean
  /** Its text morphs as segments (drawn by the morph's layer). */
  morph: Morph | null
}

export interface LayoutMorphOptions {
  /** Where keyed elements are looked for. Default `document`. */
  root?: ParentNode
  /** ms settled() waits for the incoming mirror. Default 1500. */
  timeout?: number
  /** Played from the viewport's middle when play() starts. */
  shockwave?: Shockwave | null
  /** Changed text in text-only pairs morphs as glyph segments with these
   * morph options (presets/morph.ts); false: it cross-fades. Default {}. */
  text?: Omit<MorphOptions, 'shockwave' | 'name'> | false
  name?: string
}

export interface LayoutMorph {
  /** Measure the keyed elements and hold the page as it is now; swap the
   * DOM once this resolves. */
  capture(): Promise<void>
  /** After the swap: resolves once the incoming page is mirrored, with
   * the pairs made (progress 0). */
  settled(): Promise<void>
  /** 0 = the outgoing page, 1 = the incoming page. */
  progress: number
  /** Tween progress 0 -> 1 over `ms` (default 700) with `ease` (default
   * linear), then end(). */
  play(ms?: number, ease?: (t: number) => number): Promise<void>
  /** Back to the live page; frees the snapshot and the transforms. */
  end(): void
  destroy(): void
  /** Keys paired by the last settled(). */
  readonly keys: readonly string[]
  readonly pass: Transition<LayoutMorphSchema>
}

const mixBox = (a: Box, b: Box, t: number): Box => ({
  // a (1 - t) + b t: exactly b at t = 1, so the transforms end at identity.
  x: a.x * (1 - t) + b.x * t,
  y: a.y * (1 - t) + b.y * t,
  w: a.w * (1 - t) + b.w * t,
  h: a.h * (1 - t) + b.h * t
})

const REPLACED = new Set(['IMG', 'VIDEO', 'CANVAS', 'SVG', 'svg', 'IFRAME'])

/** True when the element paints a box of its own (background, border,
 * shadow, or replaced content), so its border box is what moves. */
function paintsBox(el: Element): boolean {
  if (REPLACED.has(el.tagName)) {
    return true
  }
  const cs = getComputedStyle(el)
  const bg = cs.backgroundColor
  const clear =
    bg === 'transparent' || /rgba\(.*,\s*0\)$/.test(bg.replace(/\s+/g, ''))
  return (
    !clear ||
    cs.backgroundImage !== 'none' ||
    cs.boxShadow !== 'none' ||
    Number.parseFloat(cs.borderTopWidth) > 0 ||
    Number.parseFloat(cs.borderRightWidth) > 0 ||
    Number.parseFloat(cs.borderBottomWidth) > 0 ||
    Number.parseFloat(cs.borderLeftWidth) > 0
  )
}

const rectBox = (r: DOMRect): Box => ({
  x: r.x,
  y: r.y,
  w: r.width,
  h: r.height
})

/** What moves: the border box of an element that paints one, else the
 * box of its contents (a block heading's text, not the line it spans,
 * grown a little), so text scales with its size rather than its
 * container. */
function boxOf(el: Element): Box {
  const border = rectBox(el.getBoundingClientRect())
  if (paintsBox(el)) {
    return border
  }
  const range = document.createRange()
  range.selectNodeContents(el)
  const c = rectBox(range.getBoundingClientRect())
  if (c.w <= 0 || c.h <= 0) {
    return border
  }
  // Grown for ink past the line box (overhangs, italics), so keying the
  // old text out of the snapshot takes all of it.
  const pad =
    2 + 0.08 * (Number.parseFloat(getComputedStyle(el).fontSize) || 16)
  return { x: c.x - pad, y: c.y - pad, w: c.w + 2 * pad, h: c.h + 2 * pad }
}

const radiusOf = (el: Element, b: Box): number => {
  if (!paintsBox(el)) {
    return 0
  }
  const v = getComputedStyle(el).borderTopLeftRadius.split(' ')[0] ?? '0'
  const n = Number.parseFloat(v) || 0
  return v.endsWith('%') ? (n / 100) * Math.min(b.w, b.h) : n
}

/** The computed text colour as [r, g, b, a] (0..1). */
function colorOf(el: Element): number[] {
  const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).color)
  const v = (m?.[1] ?? '0,0,0').split(/[\s,/]+/).filter(Boolean)
  const n = v.map((x) => Number.parseFloat(x))
  return [(n[0] ?? 0) / 255, (n[1] ?? 0) / 255, (n[2] ?? 0) / 255, n[3] ?? 1]
}

const isSvg = (el: Element): boolean => el.tagName.toLowerCase() === 'svg'

interface ShapeTables {
  shapes: number
  contours: number
  sh: Float32Array
  f0: Float32Array
  f1: Float32Array
  s0: Float32Array
  s1: Float32Array
  sw: Float32Array
  ct: Float32Array
  pt: Float32Array
}

const newTables = (): ShapeTables => ({
  shapes: 0,
  contours: 0,
  sh: new Float32Array(4 * MAX_SHAPES),
  f0: new Float32Array(4 * MAX_SHAPES),
  f1: new Float32Array(4 * MAX_SHAPES),
  s0: new Float32Array(4 * MAX_SHAPES),
  s1: new Float32Array(4 * MAX_SHAPES),
  sw: new Float32Array(4 * MAX_SHAPES),
  ct: new Float32Array(4 * MAX_CONTOURS),
  pt: new Float32Array(4 * MAX_CONTOURS * M)
})

/** A colour, or the other side's at alpha 0 (none: fades in or out). */
const paint = (c: number[] | null, other: number[] | null): number[] =>
  c ?? (other ? [other[0] ?? 0, other[1] ?? 0, other[2] ?? 0, 0] : [0, 0, 0, 0])

/** `p` in box `from` carried to the same place in box `to`. */
const carry = (p: [number, number], from: Box, to: Box): [number, number] => [
  to.x + ((p[0] - from.x) * to.w) / Math.max(from.w, 1e-6),
  to.y + ((p[1] - from.y) * to.h) / Math.max(from.h, 1e-6)
]

/**
 * Write pair `pair`'s shapes (a old in box `ba`, b new in box `bb`) into
 * the tables; false when they don't fit (the pair then cross-fades as a
 * box). A subpath on one side only grows from or shrinks to its centroid
 * carried to the other side's box, so it travels with the rest.
 */
function addShapes(
  t: ShapeTables,
  pair: number,
  a: PathShape[],
  b: PathShape[],
  ba: Box,
  bb: Box
): boolean {
  const n = Math.max(a.length, b.length)
  let need = 0
  for (let k = 0; k < n; k++) {
    need += Math.max(a[k]?.contours.length ?? 0, b[k]?.contours.length ?? 0)
  }
  if (t.shapes + n > MAX_SHAPES || t.contours + need > MAX_CONTOURS) {
    return false
  }
  for (let k = 0; k < n; k++) {
    const sa = a[k]
    const sb = b[k]
    const s = t.shapes++
    const nc = Math.max(sa?.contours.length ?? 0, sb?.contours.length ?? 0)
    t.sh.set([pair, t.contours, nc, (sa ?? sb)?.evenOdd ? 1 : 0], 4 * s)
    t.f0.set(paint(sa?.fill ?? null, sb?.fill ?? null), 4 * s)
    t.f1.set(paint(sb?.fill ?? null, sa?.fill ?? null), 4 * s)
    t.s0.set(paint(sa?.stroke ?? null, sb?.stroke ?? null), 4 * s)
    t.s1.set(paint(sb?.stroke ?? null, sa?.stroke ?? null), 4 * s)
    const wa = sa?.stroke ? sa.strokeWidth : (sb?.strokeWidth ?? 0)
    const wb = sb?.stroke ? sb.strokeWidth : (sa?.strokeWidth ?? 0)
    t.sw.set([wa, wb, 0, 0], 4 * s)
    for (let j = 0; j < nc; j++) {
      const ca = sa?.contours[j]
      const cb = sb?.contours[j]
      const closed = (sa?.closed[j] ?? false) || (sb?.closed[j] ?? false)
      const ra = ca
        ? resample(ca, closed, M)
        : collapsed(...carry(cb ? centroid(cb) : [0, 0], bb, ba), M)
      let rb = cb
        ? resample(cb, closed, M)
        : collapsed(...carry(ca ? centroid(ca) : [0, 0], ba, bb), M)
      if (ca && cb) {
        rb = align(ra, rb, closed)
      }
      const c = t.contours++
      t.ct.set([closed ? 1 : 0, 0, 0, 0], 4 * c)
      for (let i = 0; i < M; i++) {
        t.pt.set(
          [
            ra[2 * i] ?? 0,
            ra[2 * i + 1] ?? 0,
            rb[2 * i] ?? 0,
            rb[2 * i + 1] ?? 0
          ],
          4 * (c * M + i)
        )
      }
    }
  }
  return true
}

/** On screen, or within a viewport of it. */
const near = (b: Box, vw: number, vh: number): boolean =>
  b.w > 0 &&
  b.h > 0 &&
  b.x + b.w > -vw &&
  b.y + b.h > -vh &&
  b.x < 2 * vw &&
  b.y < 2 * vh

export function layoutMorph(
  fx: Effects,
  opts: LayoutMorphOptions = {}
): LayoutMorph {
  const pass = fx.transition({
    name: opts.name ?? 'layout-morph',
    fragment: FRAGMENT,
    params: schema,
    timeout: opts.timeout
  })
  const p = pass.params
  const root = opts.root ?? document
  let olds = new Map<string, Old>()
  let pairs: Pair[] = []
  // Text morphs, reused across captures (their layers draw for the pass).
  const morphs: Morph[] = []
  const morphOf = (k: number, el: Element): Morph => {
    let m = morphs[k]
    if (!m) {
      m = morph(fx, el, {
        ...(opts.text || {}),
        name: `${opts.name ?? 'layout-morph'}-text-${k}`
      })
      pass.addLayer(m.layer)
      morphs[k] = m
    }
    return m
  }
  const endMorphs = (): void => {
    for (const m of morphs) {
      m.end()
    }
  }

  const keyed = (): Element[] =>
    Array.from(root.querySelectorAll(`[${KEY_ATTR}]`))

  const clearPairs = (): void => {
    for (const q of pairs) {
      q.tf?.destroy()
    }
    pairs = []
    p.count = 0
    p.shapes = 0
  }

  // Scroll at settled(): new boxes are measured then; a scroll after it
  // moves them (the page) but not the old ones (the snapshot).
  let settledAt: [number, number] = [0, 0]
  let lastShift: [number, number] = [0, 0]
  /** Where the new boxes are now, viewport CSS px. */
  const shiftNow = (): [number, number] => {
    const sx = window.scrollX - settledAt[0]
    const sy = window.scrollY - settledAt[1]
    if (sx !== lastShift[0] || sy !== lastShift[1]) {
      lastShift = [sx, sy]
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      const n = new Float32Array(4 * MAX_PAIRS)
      pairs.forEach((q, i) => {
        n.set(
          [
            (q.now.x - sx) / vw,
            (q.now.y - sy) / vh,
            q.now.w / vw,
            q.now.h / vh
          ],
          i * 4
        )
      })
      p.n = Array.from(n)
    }
    return lastShift
  }

  // Each pair's layer transform puts its new box at the box between,
  // relative to its paired ancestor's (whose transform already applies).
  const place = (t: number): void => {
    const [sx, sy] = shiftNow()
    const nowOf = (q: Pair): Box => ({
      x: q.now.x - sx,
      y: q.now.y - sy,
      w: q.now.w,
      h: q.now.h
    })
    const at = pairs.map((q) => mixBox(q.old, nowOf(q), t))
    pairs.forEach((q, i) => {
      const tf = q.tf
      const r = at[i]
      if (!tf || !r) {
        return
      }
      let want = r
      const pp = pairs[q.parent]
      const pr = at[q.parent]
      if (pp && pr) {
        const pn = nowOf(pp)
        const kx = pr.w / Math.max(pn.w, 1e-6)
        const ky = pr.h / Math.max(pn.h, 1e-6)
        want = {
          x: pn.x + (r.x - pr.x) / kx,
          y: pn.y + (r.y - pr.y) / ky,
          w: r.w / kx,
          h: r.h / ky
        }
      }
      // About the border box's corner: org + t + s (p - org) puts the
      // box `now` at `want` (all where they are now, after any scroll).
      const now = nowOf(q)
      const ox = q.org.x - sx
      const oy = q.org.y - sy
      const kx = want.w / Math.max(now.w, 1e-6)
      const ky = want.h / Math.max(now.h, 1e-6)
      tf.scaleX = kx
      tf.scaleY = ky
      // A morphing svg's shapes are drawn by the pass in flight.
      tf.opacity = q.shapes && t > 0 && t < 1 ? 0 : 1
      tf.x = want.x - ox - kx * (now.x - ox)
      tf.y = want.y - oy - ky * (now.y - oy)
      if (q.morph) {
        q.morph.progress = t
        // The live text shows only at the ends (the pass shows the pages
        // there, exactly).
        q.morph.showLive = t <= 0 || t >= 1
      }
    })
  }

  const handle: LayoutMorph = {
    pass,
    get keys() {
      return pairs.map((q) => q.key)
    },
    async capture() {
      clearPairs()
      endMorphs()
      olds = new Map()
      const texts: [Old, Element][] = []
      for (const el of keyed()) {
        const key = el.getAttribute(KEY_ATTR) ?? ''
        if (!key || olds.has(key)) {
          continue
        }
        const box = boxOf(el)
        const text = !paintsBox(el)
        const old: Old = {
          box,
          radius: radiusOf(el, box),
          text,
          color: colorOf(el),
          shapes: isSvg(el) ? fx.pathShapes(el) : [],
          string: text ? (el.textContent ?? '').trim() : '',
          morph: null
        }
        olds.set(key, old)
        if (text && old.string && texts.length < MAX_PAIRS) {
          texts.push([old, el])
        }
      }
      p.progress = 0
      // The snapshot first (with the live text), then the copies (which
      // hide it).
      await pass.capture()
      if (opts.text !== false && !fx.reducedMotion) {
        await Promise.all(
          texts.map(async ([old, el], k) => {
            const m = morphOf(k, el)
            await m.capture(el)
            old.morph = m
          })
        )
      }
    },
    async settled() {
      await pass.settled()
      clearPairs()
      if (fx.reducedMotion) {
        return
      }
      // The canvas's viewport (no classic scrollbar), as the pass's uv.
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      const o = new Float32Array(4 * MAX_PAIRS)
      const nw = new Float32Array(4 * MAX_PAIRS)
      const r = new Float32Array(4 * MAX_PAIRS)
      const c = new Float32Array(4 * MAX_PAIRS)
      const st = newTables()
      const texts: [number, Morph, Element][] = []
      const seen = new Set<string>()
      const index = new Map<Element, number>()
      for (const el of keyed()) {
        const key = el.getAttribute(KEY_ATTR) ?? ''
        const was = olds.get(key)
        if (!was || seen.has(key)) {
          continue
        }
        seen.add(key)
        const now = boxOf(el)
        if (!near(was.box, vw, vh) || !near(now, vw, vh)) {
          continue
        }
        if (pairs.length >= MAX_PAIRS) {
          console.warn(
            `[compositor-gpu] layoutMorph: more than ${MAX_PAIRS} pairs; "${key}" cross-fades`
          )
          continue
        }
        let parent = -1
        for (let a = el.parentElement; a; a = a.parentElement) {
          const k = index.get(a)
          if (k !== undefined) {
            parent = k
            break
          }
        }
        const i = pairs.length
        index.set(el, i)
        const b = el.getBoundingClientRect()
        const nowShapes = was.shapes.length > 0 ? fx.pathShapes(el) : []
        let shapes = false
        if (nowShapes.length > 0) {
          shapes = addShapes(st, i, was.shapes, nowShapes, was.box, now)
          if (!shapes) {
            console.warn(
              `[compositor-gpu] layoutMorph: "${key}" has more shapes than fit (${MAX_SHAPES} shapes, ${MAX_CONTOURS} subpaths in all); it cross-fades`
            )
          }
        }
        // Changed text morphs as segments (settled below).
        const m =
          was.morph && (el.textContent ?? '').trim() !== was.string
            ? was.morph
            : null
        if (m) {
          was.morph = null
          texts.push([i, m, el])
        }
        pairs.push({
          key,
          el,
          old: was.box,
          now,
          org: { x: b.x, y: b.y },
          parent,
          tf: fx.transform(el, { originX: 0, originY: 0 }),
          shapes,
          morph: null
        })
        o.set(
          [was.box.x / vw, was.box.y / vh, was.box.w / vw, was.box.h / vh],
          i * 4
        )
        nw.set([now.x / vw, now.y / vh, now.w / vw, now.h / vh], i * 4)
        const kind = shapes ? 2 : was.text ? 1 : 0
        r.set([was.radius, radiusOf(el, now), kind, 0], i * 4)
        c.set(was.color, i * 4)
      }
      // Copies of text that didn't pair, or didn't change, go.
      for (const was of olds.values()) {
        was.morph?.end()
        was.morph = null
      }
      await Promise.all(
        texts.map(async ([i, m, el]) => {
          await m.settled(1500, el)
          const q = pairs[i]
          if (q && m.ready) {
            q.morph = m
            r[i * 4 + 2] = 3
          } else {
            m.end()
          }
        })
      )
      p.o = Array.from(o)
      p.n = Array.from(nw)
      p.r = Array.from(r)
      p.c = Array.from(c)
      p.shapes = st.shapes
      p.sh = Array.from(st.sh)
      p.f0 = Array.from(st.f0)
      p.f1 = Array.from(st.f1)
      p.s0 = Array.from(st.s0)
      p.s1 = Array.from(st.s1)
      p.sw = Array.from(st.sw)
      p.ct = Array.from(st.ct)
      p.pt = Array.from(st.pt)
      p.count = pairs.length
      settledAt = [window.scrollX, window.scrollY]
      lastShift = [0, 0]
      place(p.progress)
    },
    get progress() {
      return p.progress
    },
    set progress(v: number) {
      const t = Math.min(1, Math.max(0, v))
      p.progress = t
      place(t)
    },
    play(ms = 700, ease = (t) => t) {
      const reduced = fx.reducedMotion
      const dur = reduced ? 150 : ms
      if (!reduced) {
        opts.shockwave?.play()
      }
      return new Promise<void>((resolve) => {
        const t0 = performance.now()
        const step = (): void => {
          const t = Math.min(1, (performance.now() - t0) / Math.max(dur, 1))
          handle.progress = reduced ? t : ease(t)
          if (t < 1) {
            requestAnimationFrame(step)
          } else {
            requestAnimationFrame(() => {
              handle.end()
              resolve()
            })
          }
        }
        requestAnimationFrame(step)
      })
    },
    end() {
      clearPairs()
      endMorphs()
      pass.end()
    },
    destroy() {
      handle.end()
      for (const m of morphs) {
        m.destroy()
      }
      morphs.length = 0
      pass.destroy()
    }
  }
  return handle
}
