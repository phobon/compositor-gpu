import type { Effects } from '../effects'
import type { Transform } from '../transform'
import type { Transition } from '../transition'
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

/** Pairs the pass can draw (more: the rest cross-fade, with a warning). */
export const MAX_PAIRS = 16

const KEY_ATTR = 'data-gpu-morph'

const table = { type: 'vec4', default: [0, 0, 0, 0], count: MAX_PAIRS } as const

const schema = {
  progress: { type: 'f32', default: 0, min: 0, max: 1 },
  count: { type: 'f32', default: 0 },
  // Per pair: old and new boxes (uv: x, y, w, h over the viewport); radii
  // (CSS px: old, new) and 1 for text (keyed out of the snapshot by its
  // colour); the old text colour (sRGB, alpha).
  o: table,
  n: table,
  r: table,
  c: table
} as const

export type LayoutMorphSchema = typeof schema

const FRAGMENT = /* wgsl */ `
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
// holds q taken out: text keyed off, a box replaced by fill (the new
// page; nothing after a box applies).
fn lm_holes(first : u32, n : u32, q : vec2f, px : vec4f, fill : vec4f,
    css : vec2f) -> vec4f {
  var o = px;
  for (var j = first; j < n; j++) {
    if (lm_in(q, lm_o(j))) {
      if (lm_r(j).z < 0.5) {
        return fill;
      }
      o = lm_unkey(j, o, css);
    }
  }
  return o;
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
    if (cov > 0.0) {
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
  return col;
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
}

export interface LayoutMorphOptions {
  /** Where keyed elements are looked for. Default `document`. */
  root?: ParentNode
  /** ms settled() waits for the incoming mirror. Default 1500. */
  timeout?: number
  /** Played from the viewport's middle when play() starts. */
  shockwave?: Shockwave | null
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

  const keyed = (): Element[] =>
    Array.from(root.querySelectorAll(`[${KEY_ATTR}]`))

  const clearPairs = (): void => {
    for (const q of pairs) {
      q.tf?.destroy()
    }
    pairs = []
    p.count = 0
  }

  // Each pair's layer transform puts its new box at the box between,
  // relative to its paired ancestor's (whose transform already applies).
  const place = (t: number): void => {
    const at = pairs.map((q) => mixBox(q.old, q.now, t))
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
        const sx = pr.w / Math.max(pp.now.w, 1e-6)
        const sy = pr.h / Math.max(pp.now.h, 1e-6)
        want = {
          x: pp.now.x + (r.x - pr.x) / sx,
          y: pp.now.y + (r.y - pr.y) / sy,
          w: r.w / sx,
          h: r.h / sy
        }
      }
      // About the border box's corner: org + t + s (p - org) puts the
      // box `now` at `want`.
      const sx = want.w / Math.max(q.now.w, 1e-6)
      const sy = want.h / Math.max(q.now.h, 1e-6)
      tf.scaleX = sx
      tf.scaleY = sy
      tf.x = want.x - q.org.x - sx * (q.now.x - q.org.x)
      tf.y = want.y - q.org.y - sy * (q.now.y - q.org.y)
    })
  }

  const handle: LayoutMorph = {
    pass,
    get keys() {
      return pairs.map((q) => q.key)
    },
    capture() {
      clearPairs()
      olds = new Map()
      for (const el of keyed()) {
        const key = el.getAttribute(KEY_ATTR) ?? ''
        if (!key || olds.has(key)) {
          continue
        }
        const box = boxOf(el)
        olds.set(key, {
          box,
          radius: radiusOf(el, box),
          text: !paintsBox(el),
          color: colorOf(el)
        })
      }
      p.progress = 0
      return pass.capture()
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
        pairs.push({
          key,
          el,
          old: was.box,
          now,
          org: { x: b.x, y: b.y },
          parent,
          tf: fx.transform(el, { originX: 0, originY: 0 })
        })
        o.set(
          [was.box.x / vw, was.box.y / vh, was.box.w / vw, was.box.h / vh],
          i * 4
        )
        nw.set([now.x / vw, now.y / vh, now.w / vw, now.h / vh], i * 4)
        r.set([was.radius, radiusOf(el, now), was.text ? 1 : 0, 0], i * 4)
        c.set(was.color, i * 4)
      }
      p.o = Array.from(o)
      p.n = Array.from(nw)
      p.r = Array.from(r)
      p.c = Array.from(c)
      p.count = pairs.length
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
      pass.end()
    },
    destroy() {
      handle.end()
      pass.destroy()
    }
  }
  return handle
}
