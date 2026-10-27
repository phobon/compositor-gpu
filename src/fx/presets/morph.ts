import { PATH_WGSL } from '../../paths/path_wgsl'
import type { GlyphGhost } from '../../text/slug/rasterizer'
import type { Effects } from '../effects'
import type { Layer } from '../layer'
import type { Material } from '../material'
import {
  assign,
  bestShift,
  type CutGlyph,
  cutGlyph,
  lcs,
  SEGMENT_POINTS,
  type Segment,
  share
} from '../morph_segments'
import type { Target } from '../target'
import type { Shockwave } from './shockwave'

// Text that morphs into its next value (M5d, first slice: in place;
// docs/EFFECTS.md, Morph). capture() copies the element's Slug glyphs as
// drawn (Effects.glyphGhost: their bands stay resident) and draws them
// from the copy while hiding the live text; the page changes the text;
// settled() waits until the new text has been drawn and copies it too.
// Then the two strings are paired: graphemes an LCS keeps move as whole
// glyphs (Slug, crisp the whole way); the changed ones are cut into
// segments across their strokes (morph_segments.ts) and paired by least
// travel, each pair's outline interpolated point to point while it
// travels along an arc and turns between the segments' axes (path
// coverage, paths/path_wgsl.ts). At rest a segment draws its glyph
// through Slug, cut by its cell (the nearest centroid), so progress 0 is
// the old text and 1 the new text exactly. Segments left over on one
// side shrink to their centroid or grow from it. Under reduced motion
// the glyphs cross-fade in place.
//
// The page drives `progress` (GSAP, Motion) or calls play(); end() hands
// back to the live text. A shockwave passed in options plays from the
// element when play() starts.

const M = SEGMENT_POINTS
const HEAD = 20
const STRIDE = HEAD + 4 * M
const GLYPH_FLOATS = 28

// Instance kinds.
const SEGMENT = 0
const RIGID = 1
const FADE_A = 2
const FADE_B = 3
// Segment flags.
const APPEAR = 1
const VANISH = 2

const schema = {
  progress: { type: 'f32', default: 0, min: 0, max: 1 },
  /** Internal: last frame's progress (motion blur of the pose). */
  prev: { type: 'f32', default: 0, min: 0, max: 1 },
  /** Internal: instances that are pieces (the rest is tables). */
  pieces: { type: 'f32', default: 0 },
  /** Internal: float offset of the glyph table in the data. */
  gbase: { type: 'f32', default: 0 },
  /** Internal: cross-fade weight for FADE instances (reduced motion). */
  fade: { type: 'f32', default: 0, min: 0, max: 1 },
  /** Stagger: how far apart pieces start, as a fraction of the run. */
  spread: { type: 'f32', default: 0.5, min: 0, max: 2 },
  /** Bend of a piece's path, as a fraction of its travel. */
  arc: { type: 'f32', default: 0.2, min: 0, max: 1 },
  /** Extra turn mid-flight, radians. */
  spin: { type: 'f32', default: 0.4, min: 0, max: 4 },
  /** Where the outline change is centred in a piece's travel. */
  swap: { type: 'f32', default: 0.5, min: 0, max: 1 },
  /** Half-width of the outline change (0.5: the whole travel). */
  soft: { type: 'f32', default: 0.5, min: 0.001, max: 0.5 }
} as const

export type MorphSchema = typeof schema

const COMMON = /* wgsl */ `
${PATH_WGSL}
const PI = 3.14159265;
const MPTS = ${M}u;
const HEAD = ${HEAD}u;

fn rot2(a : f32, v : vec2f) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * v.x - s * v.y, s * v.x + c * v.y);
}

fn tab(i : u32) -> vec2f {
  return vec2f(fx_data[i], fx_data[i + 1u]);
}

// Glyph g of the morph's own table (copies of Slug instances; gref as
// numbers).
fn mg(g : u32) -> Glyph {
  let b = u32(params.gbase) + g * ${GLYPH_FLOATS}u;
  var o : Glyph;
  o.rect = vec4f(fx_data[b], fx_data[b + 1u], fx_data[b + 2u], fx_data[b + 3u]);
  o.offset = vec4f(fx_data[b + 4u], fx_data[b + 5u], fx_data[b + 6u],
    fx_data[b + 7u]);
  o.color = vec4f(fx_data[b + 8u], fx_data[b + 9u], fx_data[b + 10u],
    fx_data[b + 11u]);
  o.gref = vec4u(u32(fx_data[b + 12u]), u32(fx_data[b + 13u]), 0u, 0u);
  o.xf0 = vec4f(fx_data[b + 20u], fx_data[b + 21u], fx_data[b + 22u],
    fx_data[b + 23u]);
  o.xf1 = vec4f(fx_data[b + 24u], fx_data[b + 25u], 0.0, 0.0);
  return o;
}

// A glyph's ink box as a frame in the layer: p = o + u * ax + v * ay.
struct GFrame { o : vec2f, ax : vec2f, ay : vec2f };

fn gframe(g : Glyph) -> GFrame {
  let m = g.xf0;
  let lin = mat2x2f(vec2f(m.x, m.y), vec2f(m.z, m.w));
  var f : GFrame;
  f.o = lin * g.rect.xy + g.xf1.xy + g.offset.xy +
    (g.offset.z - FX_SPACE) * fx.scroll;
  f.ax = lin * vec2f(g.rect.z, 0.0);
  f.ay = lin * vec2f(0.0, g.rect.w);
  return f;
}

fn fmix(a : GFrame, b : GFrame, t : f32) -> GFrame {
  var f : GFrame;
  f.o = mix(a.o, b.o, t);
  f.ax = mix(a.ax, b.ax, t);
  f.ay = mix(a.ay, b.ay, t);
  return f;
}

fn fpoint(f : GFrame, uv : vec2f) -> vec2f {
  return f.o + uv.x * f.ax + uv.y * f.ay;
}

// Slug coverage of g at em (0..1 over the ink box, y up, as the text
// pass's em) with the pixel scale given (no derivatives).
fn slug_at(g : Glyph, em : vec2f, inv : vec2f) -> f32 {
  if (g.gref.y == 0u || any(em < vec2f(-0.5)) || any(em > vec2f(1.5))) {
    return 0.0;
  }
  return slug_coverage(em, g.gref, inv);
}

// 1 where uv's nearest centroid (of n from start) is me.
fn mine(uv : vec2f, start : u32, n : u32, me : u32, asp : f32) -> f32 {
  let p = uv * vec2f(1.0, asp);
  var best = 1e9;
  var who = 0u;
  for (var j = 0u; j < n; j++) {
    let d = distance(p, tab(start + 2u * j) * vec2f(1.0, asp));
    if (d < best) {
      best = d;
      who = j;
    }
  }
  return select(0.0, 1.0, who == me);
}

fn ease(x : f32) -> f32 {
  return select(1.0 - pow(-2.0 * x + 2.0, 3.0) * 0.5, 4.0 * x * x * x,
    x < 0.5);
}

// Piece i's own progress, staggered by its random.
fn travel(i : u32, p : f32) -> f32 {
  let r = data(i, 11u);
  let s = params.spread;
  return ease(clamp(p * (1.0 + s) - r * s, 0.0, 1.0));
}

fn shape(t : f32) -> f32 {
  return smoothstep(params.swap - params.soft, params.swap + params.soft, t);
}

struct Pose { p : vec2f, a : f32 };

fn pose(i : u32, t : f32) -> Pose {
  let r = data(i, 11u);
  let pa = vec2f(data(i, 13u), data(i, 14u));
  let pb = vec2f(data(i, 15u), data(i, 16u));
  let d = pb - pa;
  let bend = sin(PI * t);
  var o : Pose;
  o.p = mix(pa, pb, t) +
    vec2f(-d.y, d.x) * bend * params.arc * (r - 0.5) * 2.0;
  o.a = mix(data(i, 9u), data(i, 10u), t) +
    params.spin * (fract(r * 13.7) - 0.5) * bend;
  return o;
}

fn pt_a(i : u32, j : u32) -> vec2f {
  return vec2f(data(i, HEAD + 2u * j), data(i, HEAD + 2u * j + 1u));
}

fn pt_b(i : u32, j : u32) -> vec2f {
  let k = HEAD + 2u * MPTS + 2u * j;
  return vec2f(data(i, k), data(i, k + 1u));
}

// A piece's visibility from its flags (appearing / vanishing pieces).
fn flag_alpha(i : u32, w : f32) -> f32 {
  let fl = u32(data(i, 12u));
  var a = 1.0;
  if ((fl & ${APPEAR}u) != 0u) {
    a = w;
  }
  if ((fl & ${VANISH}u) != 0u) {
    a = 1.0 - w;
  }
  return a;
}
`

const VERTEX = /* wgsl */ `${COMMON}
fn vertex(i : u32, corner : vec2f) -> Quad {
  var q : Quad;
  if (f32(i) >= params.pieces) {
    return q;
  }
  let kind = u32(data(i, 0u));
  let ga = mg(u32(data(i, 1u)));
  let gb = mg(u32(data(i, 2u)));
  let tn = travel(i, params.progress);
  let tp = travel(i, params.prev);
  var pos : vec2f;
  var uv : vec2f;
  var col = ga.color;
  // At rest a segment draws its whole glyph (cut by its cell in the
  // fragment), so it covers the cell wherever it reaches.
  let rest = tn == tp && (tn == 0.0 || tn == 1.0);
  if (kind == ${SEGMENT}u && !rest) {
    let now = pose(i, tn);
    var lo = vec2f(1e9);
    var hi = vec2f(-1e9);
    for (var j = 0u; j < MPTS; j++) {
      lo = min(lo, min(pt_a(i, j), pt_b(i, j)));
      hi = max(hi, max(pt_a(i, j), pt_b(i, j)));
    }
    let m = vec2f(3.0);
    pos = now.p + rot2(now.a, mix(lo - m, hi + m, corner));
    uv = pos;
    col = mix(ga.color, gb.color, shape(tn));
  } else {
    // A glyph quad built as the text pass builds it (slugBody), op for
    // op: the ink box grown by a device pixel, em over the box
    // interpolated per vertex, so a glyph at rest matches the live text
    // bit for bit.
    var g = ga;
    if (kind == ${FADE_B}u || (kind != ${FADE_A}u && tn == 1.0)) {
      g = gb;
    }
    col = g.color;
    let mx = g.xf0;
    let sc = vec2f(length(mx.xy), length(mx.zw)) * frame.dpr;
    let pad = 1.0 / max(sc, vec2f(1e-3));
    let lp = g.rect.xy - pad + corner * (g.rect.zw + 2.0 * pad);
    let e = (lp - g.rect.xy) / max(g.rect.zw, vec2f(1e-5));
    uv = vec2f(e.x, 1.0 - e.y);
    pos = vec2f(mx.x * lp.x + mx.z * lp.y, mx.y * lp.x + mx.w * lp.y) +
      g.xf1.xy + g.offset.xy + (g.offset.z - FX_SPACE) * fx.scroll;
    if (kind == ${RIGID}u && tn > 0.0 && tn < 1.0) {
      pos = fpoint(fmix(gframe(ga), gframe(gb), tn), e);
      col = mix(ga.color, gb.color, tn);
    }
  }
  q.pos = pos;
  q.uv = uv;
  q.color = col;
  q.extra = vec4f(tn, tp, shape(tn), f32(kind));
  return q;
}
`

// COMMON rides in VERTEX: both hooks land in one module.
const FRAGMENT = /* wgsl */ `
fn fragment(q : Quad, i : u32) -> vec4f {
  // Kind and travel again from the data, not the interpolated extras
  // (constants interpolated need not stay bit-exact).
  let kind = u32(data(i, 0u));
  let tn = travel(i, params.progress);
  let tp = travel(i, params.prev);
  let w = shape(tn);
  let ga = mg(u32(data(i, 1u)));
  let gb = mg(u32(data(i, 2u)));
  // Derivatives first, in uniform control flow. q.uv is the glyph's em
  // for glyph quads (as the text pass's) and the layer point for
  // segments in flight.
  let inv = 1.0 / max(fwidth(q.uv), vec2f(1e-5));
  let dx = dpdx(q.uv);
  let dy = dpdy(q.uv);
  let apx = max(length(vec2f(length(dx), length(dy))) * 0.70710678, 1e-5);
  let rest = tn == tp && (tn == 0.0 || tn == 1.0);
  let ydown = vec2f(q.uv.x, 1.0 - q.uv.y);
  // Glyph colours from the table at the ends (as the text pass).
  var col = q.color;
  if (kind == ${FADE_A}u || (kind != ${FADE_B}u && tn == 0.0)) {
    col = ga.color;
  } else if (kind == ${FADE_B}u || tn == 1.0) {
    col = gb.color;
  }
  var c = 0.0;
  if (kind == ${RIGID}u) {
    // The same grapheme both sides: blend the two glyphs (equal unless
    // the font changed), so each end is its own glyph exactly.
    c = mix(slug_at(ga, q.uv, inv), slug_at(gb, q.uv, inv), tn);
  } else if (kind == ${FADE_A}u) {
    c = slug_at(ga, q.uv, inv) * (1.0 - params.fade);
  } else if (kind == ${FADE_B}u) {
    c = slug_at(gb, q.uv, inv) * params.fade;
  } else if (rest && tn == 0.0) {
    // At rest, old: its glyph through Slug, cut by its cell.
    c = slug_at(ga, q.uv, inv) * mine(ydown, u32(data(i, 3u)),
      u32(data(i, 4u)), u32(data(i, 5u)), data(i, 18u)) *
      flag_alpha(i, 0.0);
  } else if (rest) {
    c = slug_at(gb, q.uv, inv) * mine(ydown, u32(data(i, 6u)),
      u32(data(i, 7u)), u32(data(i, 8u)), data(i, 19u)) *
      flag_alpha(i, 1.0);
  } else {
    // In flight: the outline mixed point to point, read edge by edge.
    let o = pose(i, tn);
    let l = rot2(-o.a, q.uv - o.p);
    var wind = 0;
    var acc = vec3f(1e20);
    var v0 = mix(pt_a(i, MPTS - 1u), pt_b(i, MPTS - 1u), w);
    for (var j = 0u; j < MPTS; j++) {
      let v1 = mix(pt_a(i, j), pt_b(i, j), w);
      wind += path_wind(l, v0, v1);
      acc = path_fill_acc(acc, l, v0, v1);
      v0 = v1;
    }
    c = clamp(path_fill_sd(wind, acc, false) / apx + 0.5, 0.0, 1.0) *
      flag_alpha(i, w);
  }
  let a = c * col.a;
  return vec4f(col.rgb * a, a);
}
`

export interface MorphOptions {
  /** Segments per string for the changed graphemes. Default 16. */
  pieces?: number
  spread?: number
  arc?: number
  spin?: number
  swap?: number
  soft?: number
  /** Played from the element when play() starts. */
  shockwave?: Shockwave | null
  name?: string
}

export interface Morph {
  /** Copy the text as drawn now and draw it from the copy (the live text
   * is hidden from here until end()). Resolves once the copy is taken:
   * change the text then. `el`: copy this element's text instead of the
   * morph's own (presets/layout_morph.ts reuses morphs across keyed
   * elements). */
  capture(el?: Element): Promise<void>
  /** After the change: resolves once the new text has been drawn and the
   * pieces are built (or after `timeout` ms, default 1500, with no
   * morph: the new text shows at end()). Then drive `progress`. `el`:
   * the element holding the new text, when the change replaced it (a
   * route swap); its text is hidden too until end(). */
  settled(timeout?: number, el?: Element): Promise<void>
  /** False hides the live text (the default from capture() until end());
   * true shows it while the morph draws (a caller compositing the morph
   * itself, at its ends). */
  showLive: boolean
  /** True when the last settled() built the pieces (the new text was
   * drawn in time). */
  readonly ready: boolean
  /** 0 = the old text, 1 = the new text. */
  progress: number
  /** Tween progress 0 -> 1 over `ms` (default 1100) with `ease` (default
   * linear: the pieces ease themselves), playing the shockwave if one
   * was given, then end(). Under reduced motion: a 150 ms cross-fade. */
  play(ms?: number, ease?: (t: number) => number): Promise<void>
  /** Back to the live text; frees the copies. */
  end(): void
  destroy(): void
  readonly layer: Layer<MorphSchema>
}

/** One string's glyphs as copied: frames in the layer (doc) space. */
interface Side {
  ghost: GlyphGhost
  /** Glyph table index of glyph 0 (A first, then B). */
  base: number
  frames: {
    o: [number, number]
    ax: [number, number]
    ay: [number, number]
  }[]
}

const nextFrame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => r()))

function frameOf(inst: Float32Array, k: number): Side['frames'][number] {
  const b = k * GLYPH_FLOATS
  const f = (i: number) => inst[b + i] ?? 0
  const [rx, ry, rw, rh] = [f(0), f(1), f(2), f(3)]
  const [a, bb, c, d] = [f(20), f(21), f(22), f(23)]
  // Viewport-space glyphs (offset.z 1) go to the page at the scroll now.
  const vx = f(6) === 1 ? window.scrollX : 0
  const vy = f(6) === 1 ? window.scrollY : 0
  return {
    o: [
      a * rx + c * ry + f(24) + f(4) + vx,
      bb * rx + d * ry + f(25) + f(5) + vy
    ],
    ax: [a * rw, bb * rw],
    ay: [c * rh, d * rh]
  }
}

const pointOf = (
  fr: Side['frames'][number],
  u: number,
  v: number
): [number, number] => [
  fr.o[0] + u * fr.ax[0] + v * fr.ay[0],
  fr.o[1] + u * fr.ax[1] + v * fr.ay[1]
]

export function morph(
  fx: Effects,
  el: Element | Target,
  opts: MorphOptions = {}
): Morph {
  const own = el instanceof Element ? fx.target(el) : el
  /** The element whose text is copied now (capture(el) changes it). */
  let target = own
  const pieces = Math.max(1, Math.round(opts.pieces ?? 16))
  let a: Side | null = null
  let b: Side | null = null
  let captured = -1
  let last = 0
  const layer = fx.layer({
    name: opts.name ?? 'morph',
    count: 0,
    stride: STRIDE,
    glyphs: own,
    place: { after: own },
    enabled: false,
    continuous: true,
    params: schema,
    vertex: VERTEX,
    fragment: FRAGMENT,
    update(l) {
      l.params.prev = last
      last = l.params.progress
    }
  })
  const p = layer.params
  for (const k of ['spread', 'arc', 'spin', 'swap', 'soft'] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  // Hides the live text while the morph draws it (Slug glyphs only:
  // fallback-atlas glyphs, emoji, keep drawing).
  const hider = (t: Target): Material =>
    fx.material({
      name: `${opts.name ?? 'morph'}-hide`,
      target: t,
      kinds: ['glyph'],
      enabled: false,
      // Not drawn at all until compiled (never the plain text meanwhile).
      hold: true,
      fragment: /* wgsl */ `
      fn fragment(m : MatIn) -> vec4f {
        return vec4f(0.0);
      }`
    })
  const hide: Material = hider(own)
  /** Hiders of other elements (capture(el), settled(t, el)), freed at
   * end(). */
  const extra = new Map<Element, Material>()
  let hiding = false
  let showLive = false
  /** The morph's own element is among those hidden. */
  let ownUsed = false
  const hidersOn = (): void => {
    const on = hiding && !showLive
    hide.enabled = on && ownUsed
    for (const m of extra.values()) {
      m.enabled = on
    }
  }
  /** Hide `t`'s live text while the morph runs. */
  const hideToo = (t: Target): void => {
    if (t.el === own.el) {
      ownUsed = true
    } else if (!extra.has(t.el)) {
      extra.set(t.el, hider(t))
    }
    hidersOn()
  }

  const sideOf = (ghost: GlyphGhost, base: number): Side => ({
    ghost,
    base,
    frames: Array.from({ length: ghost.count }, (_, k) =>
      frameOf(ghost.instances, k)
    )
  })

  /** Write the instances (`rows`, STRIDE floats each), then the glyph
   * table and the centroid table, into the layer. */
  const upload = (rows: Float32Array[], table: number[]): void => {
    const glyphs: Side[] = [a, b].filter((s): s is Side => s !== null)
    const nGlyphs = glyphs.reduce((n, s) => n + s.ghost.count, 0)
    const gbase = rows.length * STRIDE
    const tbase = gbase + nGlyphs * GLYPH_FLOATS
    const total = tbase + table.length
    layer.count = Math.max(1, Math.ceil(total / STRIDE))
    const d = layer.data
    d.fill(0)
    rows.forEach((r, i) => {
      // Centroid table offsets are relative until now.
      r[3] = (r[3] ?? 0) + tbase
      r[6] = (r[6] ?? 0) + tbase
      d.set(r, i * STRIDE)
    })
    for (const s of glyphs) {
      const u32 = new Uint32Array(
        s.ghost.instances.buffer,
        s.ghost.instances.byteOffset,
        s.ghost.instances.length
      )
      for (let k = 0; k < s.ghost.count; k++) {
        const o = gbase + (s.base + k) * GLYPH_FLOATS
        d.set(
          s.ghost.instances.subarray(k * GLYPH_FLOATS, (k + 1) * GLYPH_FLOATS),
          o
        )
        // gref as plain numbers (the shader reads floats).
        d[o + 12] = u32[k * GLYPH_FLOATS + 12] ?? 0
        d[o + 13] = u32[k * GLYPH_FLOATS + 13] ?? 0
      }
    }
    d.set(table, tbase)
    p.pieces = rows.length
    p.gbase = gbase
    layer.markDirty()
  }

  const row = (kind: number, ga: number, gb: number): Float32Array => {
    const r = new Float32Array(STRIDE)
    r[0] = kind
    r[1] = ga
    r[2] = gb
    return r
  }

  /** The old text at rest, whole glyphs. */
  const restRows = (s: Side): Float32Array[] =>
    s.frames.map((_, k) => row(FADE_A, s.base + k, s.base + k))

  const build = (sa: Side, sb: Side): Float32Array[] => {
    pendingTable = []
    if (fx.reducedMotion) {
      return [
        ...sa.frames.map((_, k) => row(FADE_A, sa.base + k, sa.base + k)),
        ...sb.frames.map((_, k) => row(FADE_B, sb.base + k, sb.base + k))
      ]
    }
    const rows: Float32Array[] = []
    const table: number[] = []
    let seed = 7
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    // Kept graphemes move whole.
    const kept = lcs(sa.ghost.text, sb.ghost.text).filter(
      ([i, j]) => sa.ghost.outlines[i] && sb.ghost.outlines[j]
    )
    const keptA = new Set(kept.map(([i]) => i))
    const keptB = new Set(kept.map(([, j]) => j))
    for (const [i, j] of kept) {
      const r = row(RIGID, sa.base + i, sb.base + j)
      r[11] = rand()
      rows.push(r)
    }
    // The changed ones, cut into segments.
    const cuts = (s: Side, keep: Set<number>) => {
      const idx: number[] = []
      const weights: number[] = []
      s.ghost.outlines.forEach((o, k) => {
        if (o && !keep.has(k) && /\S/u.test(s.ghost.text[k] ?? '')) {
          const fr = s.frames[k] as Side['frames'][number]
          idx.push(k)
          weights.push(Math.hypot(...fr.ax) * Math.hypot(...fr.ay))
        }
      })
      const counts = share(weights, pieces)
      const out: { k: number; cut: CutGlyph; seg: Segment; me: number }[] = []
      const starts = new Map<number, number>()
      idx.forEach((k, n) => {
        const fr = s.frames[k] as Side['frames'][number]
        const aspect =
          Math.hypot(...fr.ay) / Math.max(Math.hypot(...fr.ax), 1e-6)
        const cut = cutGlyph(s.ghost.outlines[k] ?? [], aspect, counts[n] ?? 0)
        starts.set(k, table.length)
        for (const seg of cut.segments) {
          table.push(seg.cx, seg.cy)
        }
        cut.segments.forEach((seg, me) => {
          out.push({ k, cut, seg, me })
        })
      })
      return { out, starts }
    }
    const ca = cuts(sa, keptA)
    const cb = cuts(sb, keptB)
    type Piece = (typeof ca.out)[number]
    const docOf = (s: Side, pc: Piece): [number, number] =>
      pointOf(s.frames[pc.k] as Side['frames'][number], pc.seg.cx, pc.seg.cy)
    const angleOf = (s: Side, pc: Piece): number => {
      const fr = s.frames[pc.k] as Side['frames'][number]
      return pc.seg.angle + Math.atan2(fr.ax[1], fr.ax[0])
    }
    /** The segment's outline in the layer, centred on its centroid and
     * turned by -angle. */
    const localOf = (s: Side, pc: Piece, angle: number): Float64Array => {
      const fr = s.frames[pc.k] as Side['frames'][number]
      const [px, py] = docOf(s, pc)
      const c = Math.cos(-angle)
      const sn = Math.sin(-angle)
      const out = new Float64Array(M * 2)
      for (let j = 0; j < M; j++) {
        const [x, y] = pointOf(
          fr,
          pc.seg.loop[j * 2] ?? 0,
          pc.seg.loop[j * 2 + 1] ?? 0
        )
        out[j * 2] = c * (x - px) - sn * (y - py)
        out[j * 2 + 1] = sn * (x - px) + c * (y - py)
      }
      return out
    }
    const segRow = (
      pa: Piece,
      pb: Piece,
      sideA: Side,
      sideB: Side,
      flags: number,
      startsA: Map<number, number>,
      startsB: Map<number, number>
    ): Float32Array => {
      const r = row(SEGMENT, sideA.base + pa.k, sideB.base + pb.k)
      const ta = angleOf(sideA, pa)
      let tb = angleOf(sideB, pb)
      while (tb - ta > Math.PI / 2) {
        tb -= Math.PI
      }
      while (tb - ta < -Math.PI / 2) {
        tb += Math.PI
      }
      const la = localOf(sideA, pa, ta)
      let lb = localOf(sideB, pb, tb)
      if (flags & APPEAR) {
        la.fill(0)
      }
      if (flags & VANISH) {
        lb = new Float64Array(M * 2)
      }
      const shift = flags ? 0 : bestShift(la, lb)
      r[3] = startsA.get(pa.k) ?? 0
      r[4] = pa.cut.segments.length
      r[5] = pa.me
      r[6] = startsB.get(pb.k) ?? 0
      r[7] = pb.cut.segments.length
      r[8] = pb.me
      r[9] = ta
      r[10] = tb
      r[11] = rand()
      r[12] = flags
      // Centroids (a leftover piece is its own pair: both the same).
      const [ax, ay] = docOf(sideA, pa)
      const [bx, by] = docOf(sideB, pb)
      r[13] = ax
      r[14] = ay
      r[15] = bx
      r[16] = by
      r[18] = pa.cut.aspect
      r[19] = pb.cut.aspect
      for (let j = 0; j < M; j++) {
        const jb = (j + shift) % M
        r[HEAD + j * 2] = la[j * 2] ?? 0
        r[HEAD + j * 2 + 1] = la[j * 2 + 1] ?? 0
        r[HEAD + 2 * M + j * 2] = lb[jb * 2] ?? 0
        r[HEAD + 2 * M + j * 2 + 1] = lb[jb * 2 + 1] ?? 0
      }
      return r
    }
    const n = Math.min(ca.out.length, cb.out.length)
    if (n > 0) {
      const cost = new Float64Array(n * n)
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const [x0, y0] = docOf(sa, ca.out[i] as Piece)
          const [x1, y1] = docOf(sb, cb.out[j] as Piece)
          cost[i * n + j] = (x0 - x1) ** 2 + (y0 - y1) ** 2
        }
      }
      const match = assign(cost, n)
      for (let i = 0; i < n; i++) {
        rows.push(
          segRow(
            ca.out[i] as Piece,
            cb.out[match[i] ?? 0] as Piece,
            sa,
            sb,
            0,
            ca.starts,
            cb.starts
          )
        )
      }
    }
    // Leftovers: shrink away or grow in, on their own glyph.
    for (let i = n; i < ca.out.length; i++) {
      const pc = ca.out[i] as Piece
      rows.push(segRow(pc, pc, sa, sa, VANISH, ca.starts, ca.starts))
    }
    for (let j = n; j < cb.out.length; j++) {
      const pc = cb.out[j] as Piece
      rows.push(segRow(pc, pc, sb, sb, APPEAR, cb.starts, cb.starts))
    }
    pendingTable = table
    return rows
  }
  let pendingTable: number[] = []

  const release = (): void => {
    a?.ghost.release()
    b?.ghost.release()
    a = null
    b = null
  }

  const handle: Morph = {
    layer,
    get progress() {
      return p.progress
    },
    set progress(v: number) {
      p.progress = Math.min(1, Math.max(0, v))
      if (fx.reducedMotion) {
        p.fade = p.progress
      }
    },
    get ready() {
      return b !== null
    },
    get showLive() {
      return showLive
    },
    set showLive(v: boolean) {
      showLive = v
      hidersOn()
    },
    async capture(el?: Element) {
      release()
      target = el ? fx.target(el) : own
      let ghost = fx.glyphGhost(target)
      for (let i = 0; !ghost && i < 90; i++) {
        await nextFrame()
        ghost = fx.glyphGhost(target)
      }
      if (!ghost) {
        return
      }
      a = sideOf(ghost, 0)
      captured = target.version
      p.progress = 0
      p.prev = 0
      p.fade = 0
      last = 0
      upload(restRows(a), [])
      layer.enabled = true
      hiding = true
      hideToo(target)
      // One frame so the copy is drawn before the page changes the text.
      await nextFrame()
    },
    async settled(timeout = 1500, el?: Element) {
      if (!a) {
        return
      }
      const from = target
      if (el && el !== target.el) {
        target = fx.target(el)
        hideToo(target)
      }
      const until = performance.now() + timeout
      let ghost: GlyphGhost | null = null
      const before = a.ghost.text.join('')
      while (performance.now() < until) {
        await nextFrame()
        const same = target === from
        if (same && target.version === captured) {
          continue
        }
        const g = fx.glyphGhost(target)
        // A re-read for another reason can still hold the old text.
        if (
          same &&
          g &&
          g.text.join('') === before &&
          performance.now() < until
        ) {
          g.release()
          continue
        }
        ghost = g
        if (ghost) {
          break
        }
      }
      if (!ghost) {
        return
      }
      b = sideOf(ghost, a.ghost.count)
      const rows = build(a, b)
      upload(rows, pendingTable)
    },
    play(ms = 1100, ease = (t) => t) {
      const reduced = fx.reducedMotion
      const dur = reduced ? 150 : ms
      if (!reduced) {
        opts.shockwave?.play(target)
      }
      return new Promise<void>((resolve) => {
        const t0 = performance.now()
        const step = (): void => {
          const t = Math.min(1, (performance.now() - t0) / Math.max(dur, 1))
          handle.progress = reduced ? t : ease(t)
          if (t < 1) {
            requestAnimationFrame(step)
          } else {
            // Two frames at rest (Slug, not the outlines), then hand
            // back to the live text.
            void nextFrame()
              .then(nextFrame)
              .then(() => {
                handle.end()
                resolve()
              })
          }
        }
        requestAnimationFrame(step)
      })
    },
    end() {
      layer.enabled = false
      hiding = false
      ownUsed = false
      hide.enabled = false
      for (const m of extra.values()) {
        m.destroy()
      }
      extra.clear()
      release()
    },
    destroy() {
      handle.end()
      layer.destroy()
      hide.destroy()
    }
  }
  return handle
}
