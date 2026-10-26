// typegpu reads process.env at evaluation: the shim must run first.
import '@/util/env'
import './nav'
import { mountDebugPanel } from '@/debug'
import { createEffects, type Layer, type Target } from '@/fx'
import { createCompositor } from '@/index'

// Throwaway spike (M5 plan, Q22, third cut): glyph segments whose
// outlines morph into the next string's, as in the reference (83 ->
// S15_ -> 32* -> 5/6): point-to-point path interpolation, as SVG morph
// tools do, drawn on the GPU through fx.layer (no src/ changes).
//
// Segments: each grapheme is rasterised once with Canvas 2D (its ink box
// is the glyph uv Slug uses: the outline's tight bbox) and its ink is
// split by k-means into compact chunks; a string gets `pieces` chunks,
// shared over its glyphs by ink area. A chunk's outline is the 0.5 level
// of min(ink alpha, distance to the cuts between centroids), traced by
// marching squares (largest loop) and resampled to M points by length.
// The outgoing string's chunks are paired one to one with the
// incoming's (Hungarian assignment on travel), and each pair's start
// point is rotated to the one that moves its points least.
//
// Drawing: one Layer instance per pair. At rest (progress 0 or 1) it
// draws its glyph's own chunk with Slug's coverage, masked to the
// pixels whose nearest centroid is the chunk's (the Voronoi partitions
// the ink exactly), so the rest states are the plain text. In flight it
// fills the polygon whose points are mixed from the old outline to the
// new one (by `swap` / `soft`), carried along an arc from the old
// centroid to the new and turned between the chunks' principal axes:
// nonzero winding and the distance to the nearest edge give exact
// anti-aliasing. Motion blur samples the polygon at `taps` times across
// the last frame (shape and pose both), split into red / green / blue
// windows for the fringe.
//
// Not the real design: outlines come from a raster (the path pass and
// the bake tool would cut and resample the font outline itself), a hole
// inside one chunk is dropped while it flies, and the fringe assumes the
// page background under the piece (`bg`; no dual-source blending).
//
// The bulge, blur and colour split are a separate fullscreen post pass
// over the whole frame (see "Post pass"): a bulge at the text's centre
// when a morph starts, expanding outward as a slow ring. The per-piece
// blur and fringe stay as knobs, off by default.
//
// Query: ?rows=N, ?size=px, ?pieces=, ?taps=, ?blur=, ?fringe=, ?ms=,
// ?hold= (ms between morphs), ?off (the plain page), ?nopost, and the
// post pass's ?bulge=, ?width=, ?zoom=, ?split=, ?pfringe=, ?ptaps=,
// ?speed=, ?life=, ?decay=.
//
// Measuring (M1 Pro, headed, dpr 2): /spike_morph.html?rows=6&size=96,
// then `await __spike.sweep()` in the console: 3 s per config (plain
// page; the morph alone at 8/16/32 pieces; 16 pieces with the post pass
// at 1/4/8/16 taps), a table of frames, dropped,
// late, gpu total p50/p95 and CPU p95. Budget (Q20): gpu total p95 <=
// 1.5 ms above the plain page, 0 dropped at 120 Hz.

const q = new URLSearchParams(location.search)
const num = (k: string, d: number): number => {
  const v = q.get(k)
  return v === null ? d : Number(v)
}
const at = (a: ArrayLike<number>, i: number): number => a[i] ?? 0

const STRINGS = ['83', 'S<sup>15</sup>_', '32<sup>*</sup>', '5/6']
const M = Math.max(8, Math.round(num('m', 64))) // outline points per chunk
const HEAD = 16 // header floats per pair
const STRIDE = HEAD + 4 * M

interface Stage {
  out: HTMLSpanElement
  inn: HTMLSpanElement
  outT: Target
  inT: Target
  row: number
}

const rowsEl = document.getElementById('rows') as HTMLElement
const nRows = Math.max(1, num('rows', 1))
const stageEls: HTMLElement[] = []
for (let r = 0; r < nRows; r++) {
  const s = document.createElement('div')
  s.className = 'stage'
  s.style.setProperty('--size', `${num('size', 200)}px`)
  s.append(document.createElement('span'), document.createElement('span'))
  rowsEl.append(s)
  stageEls.push(s)
}

const compositor = await createCompositor({ mode: 'replace' })
compositor.start()
if (!navigator.webdriver) {
  mountDebugPanel(compositor)
}
const fx = createEffects(compositor)
const all = fx.target(rowsEl)
const stages: Stage[] = stageEls.map((s, row) => {
  const out = s.children[0] as HTMLSpanElement
  const inn = s.children[1] as HTMLSpanElement
  return { out, inn, outT: fx.target(out), inT: fx.target(inn), row }
})

let step = 0
const setText = (): void => {
  for (const s of stages) {
    const a = (step + s.row) % STRINGS.length
    s.out.innerHTML = STRINGS[a] ?? ''
    s.inn.innerHTML = STRINGS[(a + 1) % STRINGS.length] ?? ''
  }
}
setText()

// --- Segments (CPU) ------------------------------------------------------

const RASTER = 400 // px font size the graphemes are rasterised at
const PAD = 2

interface Ink {
  bw: number // ink box, raster px
  bh: number
  w: number // canvas, px (ink box + PAD each side)
  h: number
  alpha: Uint8Array
  pts: Float32Array // x, y per sampled ink pixel (raster px from the box)
  n: number
}

const inkCache = new Map<string, Ink>()
let inkFont = ''

function ink(g: string): Ink {
  const hit = inkCache.get(g)
  if (hit) {
    return hit
  }
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    throw new Error('no 2d context')
  }
  ctx.font = inkFont
  const m = ctx.measureText(g)
  const l = m.actualBoundingBoxLeft
  const a = m.actualBoundingBoxAscent
  const bw = Math.max(1, l + m.actualBoundingBoxRight)
  const bh = Math.max(1, a + m.actualBoundingBoxDescent)
  c.width = Math.ceil(bw) + PAD * 2
  c.height = Math.ceil(bh) + PAD * 2
  ctx.font = inkFont
  ctx.fillText(g, l + PAD, a + PAD)
  const img = ctx.getImageData(0, 0, c.width, c.height).data
  const alpha = new Uint8Array(c.width * c.height)
  const pts: number[] = []
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const v = at(img, (y * c.width + x) * 4 + 3)
      alpha[y * c.width + x] = v
      if (v > 127 && x % 3 === 0 && y % 3 === 0) {
        pts.push(x - PAD, y - PAD)
      }
    }
  }
  const out: Ink = {
    bw,
    bh,
    w: c.width,
    h: c.height,
    alpha,
    pts: new Float32Array(pts),
    n: pts.length / 2
  }
  inkCache.set(g, out)
  return out
}

interface Chunk {
  cx: number // centroid, raster px from the ink box
  cy: number
  angle: number // principal axis, radians (y down)
  loop: Float32Array // M outline points (x, y), raster px, positive area
  r: number // farthest outline point from the centroid, raster px
}

const chunkCache = new Map<string, Chunk[]>()

// Deterministic k-means of a glyph's ink into k chunks, with outlines.
function chunks(gr: string, g: Ink, k: number): Chunk[] {
  const key = `${gr}\u0000${k}`
  const hit = chunkCache.get(key)
  if (hit) {
    return hit
  }
  const { pts, n } = g
  if (n === 0 || k === 0) {
    return []
  }
  k = Math.min(k, n)
  const cx = new Float64Array(k)
  const cy = new Float64Array(k)
  // Farthest-point seeding from the first pixel: spread, reproducible.
  cx[0] = at(pts, 0)
  cy[0] = at(pts, 1)
  const near = new Float64Array(n).fill(Number.POSITIVE_INFINITY)
  for (let c = 1; c < k; c++) {
    let best = -1
    let bi = 0
    for (let i = 0; i < n; i++) {
      const dx = at(pts, i * 2) - at(cx, c - 1)
      const dy = at(pts, i * 2 + 1) - at(cy, c - 1)
      const d = Math.min(at(near, i), dx * dx + dy * dy)
      near[i] = d
      if (d > best) {
        best = d
        bi = i
      }
    }
    cx[c] = at(pts, bi * 2)
    cy[c] = at(pts, bi * 2 + 1)
  }
  const own = new Int32Array(n)
  for (let it = 0; it < 16; it++) {
    for (let i = 0; i < n; i++) {
      let best = Number.POSITIVE_INFINITY
      for (let c = 0; c < k; c++) {
        const dx = at(pts, i * 2) - at(cx, c)
        const dy = at(pts, i * 2 + 1) - at(cy, c)
        const d = dx * dx + dy * dy
        if (d < best) {
          best = d
          own[i] = c
        }
      }
    }
    const sx = new Float64Array(k)
    const sy = new Float64Array(k)
    const sn = new Float64Array(k)
    for (let i = 0; i < n; i++) {
      const c = at(own, i)
      sx[c] = at(sx, c) + at(pts, i * 2)
      sy[c] = at(sy, c) + at(pts, i * 2 + 1)
      sn[c] = at(sn, c) + 1
    }
    for (let c = 0; c < k; c++) {
      if (at(sn, c) > 0) {
        cx[c] = at(sx, c) / at(sn, c)
        cy[c] = at(sy, c) / at(sn, c)
      }
    }
  }
  const out: Chunk[] = []
  for (let c = 0; c < k; c++) {
    let xx = 0
    let yy = 0
    let xy = 0
    for (let i = 0; i < n; i++) {
      if (at(own, i) !== c) {
        continue
      }
      const dx = at(pts, i * 2) - at(cx, c)
      const dy = at(pts, i * 2 + 1) - at(cy, c)
      xx += dx * dx
      yy += dy * dy
      xy += dx * dy
    }
    const loop = outline(g, cx, cy, c, k)
    let r = 1
    for (let j = 0; j < M; j++) {
      r = Math.max(
        r,
        Math.hypot(at(loop, j * 2) - at(cx, c), at(loop, j * 2 + 1) - at(cy, c))
      )
    }
    out.push({
      cx: at(cx, c),
      cy: at(cy, c),
      angle: 0.5 * Math.atan2(2 * xy, xx - yy),
      loop,
      r
    })
  }
  chunkCache.set(key, out)
  return out
}

// Chunk c's outline: the 0.5 level of min(ink alpha, signed distance to
// the cuts between its centroid and the others), traced by marching
// squares over its region; the largest loop, resampled to M points.
function outline(
  g: Ink,
  cx: Float64Array,
  cy: Float64Array,
  c: number,
  k: number
): Float32Array {
  const ox = at(cx, c)
  const oy = at(cy, c)
  // Field over the whole canvas (nodes at pixel centres, ink coords).
  const { w, h } = g
  const f = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const a = at(g.alpha, y * w + x) / 255
      if (a <= 0) {
        continue
      }
      const px = x - PAD
      const py = y - PAD
      const dc = (px - ox) ** 2 + (py - oy) ** 2
      let sd = Number.POSITIVE_INFINITY
      for (let o = 0; o < k; o++) {
        if (o === c) {
          continue
        }
        const qx = at(cx, o)
        const qy = at(cy, o)
        const len = Math.hypot(qx - ox, qy - oy)
        if (len < 1e-6) {
          continue
        }
        const d = ((px - qx) ** 2 + (py - qy) ** 2 - dc) / (2 * len)
        if (d < sd) {
          sd = d
        }
      }
      f[y * w + x] = Math.min(a, Math.min(1, Math.max(0, 0.5 + sd)))
    }
  }
  // Marching squares: crossing points on cell edges, linked undirected
  // (each edge borders two cells), then walked into loops.
  const pos = new Map<number, [number, number]>()
  const adj = new Map<number, number[]>()
  const val = (x: number, y: number) => at(f, y * w + x)
  const cross = (
    id: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ) => {
    if (!pos.has(id)) {
      const a = val(x0, y0)
      const b = val(x1, y1)
      const t = (0.5 - a) / (b - a)
      pos.set(id, [x0 + (x1 - x0) * t - PAD, y0 + (y1 - y0) * t - PAD])
    }
    return id
  }
  const link = (a: number, b: number) => {
    adj.set(a, [...(adj.get(a) ?? []), b])
    adj.set(b, [...(adj.get(b) ?? []), a])
  }
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = val(x, y) > 0.5
      const tr = val(x + 1, y) > 0.5
      const br = val(x + 1, y + 1) > 0.5
      const bl = val(x, y + 1) > 0.5
      if (tl === tr && tr === br && br === bl) {
        continue
      }
      const T = () => cross((y * w + x) * 2, x, y, x + 1, y)
      const B = () => cross(((y + 1) * w + x) * 2, x, y + 1, x + 1, y + 1)
      const L = () => cross((y * w + x) * 2 + 1, x, y, x, y + 1)
      const R = () => cross((y * w + x + 1) * 2 + 1, x + 1, y, x + 1, y + 1)
      const es: number[] = []
      if (tl !== tr) es.push(T())
      if (tr !== br) es.push(R())
      if (br !== bl) es.push(B())
      if (bl !== tl) es.push(L())
      if (es.length === 2) {
        link(at(es, 0), at(es, 1))
        continue
      }
      // Saddle: cut off the corners that differ from the centre.
      const centre =
        (val(x, y) + val(x + 1, y) + val(x + 1, y + 1) + val(x, y + 1)) / 4 >
        0.5
      if (centre === tl) {
        link(T(), R())
        link(B(), L())
      } else {
        link(T(), L())
        link(B(), R())
      }
    }
  }
  let best: [number, number][] = []
  let bestArea = 0
  const seen = new Set<number>()
  for (const start of adj.keys()) {
    if (seen.has(start)) {
      continue
    }
    const loop: [number, number][] = []
    let prev = -1
    let cur = start
    while (!seen.has(cur)) {
      seen.add(cur)
      const p = pos.get(cur)
      if (p) {
        loop.push(p)
      }
      const nx = (adj.get(cur) ?? []).find((v) => v !== prev && !seen.has(v))
      if (nx === undefined) {
        break
      }
      prev = cur
      cur = nx
    }
    let area = 0
    loop.forEach((p, i) => {
      const q2 = loop[(i + 1) % loop.length] ?? p
      area += p[0] * q2[1] - q2[0] * p[1]
    })
    if (Math.abs(area) > Math.abs(bestArea)) {
      bestArea = area
      best = loop
    }
  }
  if (bestArea < 0) {
    best.reverse()
  }
  return resample(best, ox, oy)
}

// M points evenly spaced by length around a closed loop (a dot at the
// centroid when there is none).
function resample(loop: [number, number][], ox: number, oy: number) {
  const out = new Float32Array(M * 2)
  if (loop.length < 3) {
    for (let j = 0; j < M; j++) {
      out[j * 2] = ox
      out[j * 2 + 1] = oy
    }
    return out
  }
  const cum = [0]
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i] ?? [0, 0]
    const b = loop[(i + 1) % loop.length] ?? a
    cum.push(at(cum, i) + Math.hypot(b[0] - a[0], b[1] - a[1]))
  }
  const total = at(cum, loop.length)
  let i = 0
  for (let j = 0; j < M; j++) {
    const d = (j / M) * total
    while (i < loop.length - 1 && at(cum, i + 1) < d) {
      i++
    }
    const a = loop[i] ?? [0, 0]
    const b = loop[(i + 1) % loop.length] ?? a
    const seg = Math.max(at(cum, i + 1) - at(cum, i), 1e-6)
    const t = (d - at(cum, i)) / seg
    out[j * 2] = a[0] + (b[0] - a[0]) * t
    out[j * 2 + 1] = a[1] + (b[1] - a[1]) * t
  }
  return out
}

// Share `total` chunks over glyphs by weight (largest remainder; every
// glyph with ink gets one while there are enough).
function share(weights: number[], total: number): number[] {
  const live = weights.filter((w) => w > 0).length
  const out: number[] = weights.map((w) => (w > 0 && total >= live ? 1 : 0))
  let left = total - out.reduce((a, b) => a + b, 0)
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0 || left <= 0) {
    return out
  }
  const want = weights.map((w) => (w / sum) * left)
  want.forEach((w, i) => {
    out[i] = at(out, i) + Math.floor(w)
  })
  left -= want.reduce((a, w) => a + Math.floor(w), 0)
  const order = want
    .map((w, i) => [w - Math.floor(w), i] as const)
    .sort((a, b) => b[0] - a[0])
  for (let j = 0; j < left; j++) {
    const i = order[j % order.length]?.[1] ?? 0
    out[i] = at(out, i) + 1
  }
  return out
}

// Min-cost perfect matching of an n x n cost matrix (Hungarian, O(n^3)):
// match[i] = the column row i takes.
function assign(cost: Float64Array, n: number): Int32Array {
  const u = new Float64Array(n + 1)
  const v = new Float64Array(n + 1)
  const p = new Int32Array(n + 1)
  const way = new Int32Array(n + 1)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Float64Array(n + 1).fill(Number.POSITIVE_INFINITY)
    const used = new Uint8Array(n + 1)
    do {
      used[j0] = 1
      const i0 = at(p, j0)
      let delta = Number.POSITIVE_INFINITY
      let j1 = 0
      for (let j = 1; j <= n; j++) {
        if (at(used, j)) {
          continue
        }
        const cur = at(cost, (i0 - 1) * n + j - 1) - at(u, i0) - at(v, j)
        if (cur < at(minv, j)) {
          minv[j] = cur
          way[j] = j0
        }
        if (at(minv, j) < delta) {
          delta = at(minv, j)
          j1 = j
        }
      }
      for (let j = 0; j <= n; j++) {
        if (at(used, j)) {
          u[at(p, j)] = at(u, at(p, j)) + delta
          v[j] = at(v, j) - delta
        } else {
          minv[j] = at(minv, j) - delta
        }
      }
      j0 = j1
    } while (at(p, j0) !== 0)
    do {
      const j1 = at(way, j0)
      p[j0] = at(p, j1)
      j0 = j1
    } while (j0)
  }
  const match = new Int32Array(n)
  for (let j = 1; j <= n; j++) {
    match[at(p, j) - 1] = j - 1
  }
  return match
}

// One side of a stage: its glyphs' chunks, with page positions for the
// matching and their slots in the centroid table.
interface Side {
  k: number // layer glyph index
  chunk: Chunk
  me: number // index among its glyph's chunks
  start: number // table offset (floats, relative) of its glyph's chunks
  count: number
  ink: Ink
  scale: number // raster px -> CSS px, approximately
  x: number // approximate page position, for the matching only
  y: number
}

function side(t: Target, k0: number, total: number, table: number[]): Side[] {
  const g = t.glyphs
  const inks = g.text.map((s) => ink(s))
  const scale = (j: number) => at(g.rects, j * 4 + 3) / RASTER
  const weights = inks.map((s, j) => s.n * scale(j) ** 2)
  const counts = share(weights, total)
  const out: Side[] = []
  inks.forEach((s, j) => {
    const cs = chunks(g.text[j] ?? '', s, at(counts, j))
    const start = table.length
    for (const c of cs) {
      table.push(c.cx / s.bw, c.cy / s.bh)
    }
    const rx = at(g.rects, j * 4)
    const ry = at(g.rects, j * 4 + 1)
    const rw = at(g.rects, j * 4 + 2)
    const rh = at(g.rects, j * 4 + 3)
    cs.forEach((c, me) => {
      out.push({
        k: k0 + j,
        chunk: c,
        me,
        start,
        count: cs.length,
        ink: s,
        scale: scale(j),
        x: rx + rw / 2 + (c.cx - s.bw / 2) * scale(j),
        y: ry + rh / 2 + (c.cy - s.bh / 2) * scale(j)
      })
    })
  })
  return out
}

// The cyclic shift of b's points that moves a's least, comparing both
// outlines centred and turned to their own axes, in CSS px.
function align(a: Side, b: Side, tb: number): number {
  const local = (s: Side, angle: number) => {
    const out = new Float64Array(M * 2)
    const c = Math.cos(-angle)
    const sn = Math.sin(-angle)
    for (let j = 0; j < M; j++) {
      const dx = (at(s.chunk.loop, j * 2) - s.chunk.cx) * s.scale
      const dy = (at(s.chunk.loop, j * 2 + 1) - s.chunk.cy) * s.scale
      out[j * 2] = c * dx - sn * dy
      out[j * 2 + 1] = sn * dx + c * dy
    }
    return out
  }
  const la = local(a, a.chunk.angle)
  const lb = local(b, tb)
  let best = 0
  let bestCost = Number.POSITIVE_INFINITY
  for (let s = 0; s < M; s++) {
    let cost = 0
    for (let j = 0; j < M; j++) {
      const i = (j + s) % M
      cost +=
        (at(la, j * 2) - at(lb, i * 2)) ** 2 +
        (at(la, j * 2 + 1) - at(lb, i * 2 + 1)) ** 2
    }
    if (cost < bestCost) {
      bestCost = cost
      best = s
    }
  }
  return best
}

// --- Shaders -------------------------------------------------------------

const COMMON = /* wgsl */ `
const PI = 3.14159265;
const MPTS = ${M}u;
const PAIR_HEAD = ${HEAD}u;

fn rot2(a : f32, v : vec2f) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * v.x - s * v.y, s * v.x + c * v.y);
}

fn tab(i : u32) -> vec2f {
  return vec2f(fx_data[i], fx_data[i + 1u]);
}

// 1 where uv's nearest chunk centroid (of n from start) is me.
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

// Glyph k's uv frame in the layer: p = o + uv.x * ax + uv.y * ay.
struct GFrame { o : vec2f, ax : vec2f, ay : vec2f };

fn gframe(k : u32) -> GFrame {
  var f : GFrame;
  f.o = glyph_point(k, vec2f(0.0));
  f.ax = glyph_point(k, vec2f(1.0, 0.0)) - f.o;
  f.ay = glyph_point(k, vec2f(0.0, 1.0)) - f.o;
  return f;
}

fn from_uv(f : GFrame, uv : vec2f) -> vec2f {
  return f.o + uv.x * f.ax + uv.y * f.ay;
}

fn to_uv(f : GFrame, p : vec2f) -> vec2f {
  let det = f.ax.x * f.ay.y - f.ax.y * f.ay.x;
  let d = p - f.o;
  return vec2f(d.x * f.ay.y - d.y * f.ay.x, f.ax.x * d.y - f.ax.y * d.x) /
    det;
}

// Slug coverage of glyph k at uv with the pixel scale given (no
// derivatives: callable after a non-uniform branch).
fn slug(k : u32, uv : vec2f, inv : vec2f) -> f32 {
  let g = fx_glyph(k);
  var gref = g.gref;
  if (gref.y == 0u) {
    gref = vec4u(0u, 1u, 0u, 0u);
  }
  return select(slug_coverage(vec2f(uv.x, 1.0 - uv.y), gref, inv), 0.0,
    g.gref.y == 0u);
}

struct Ends {
  ka : u32,
  kb : u32,
  fa : GFrame,
  fb : GFrame,
  pa : vec2f,   // centroids, layer space
  pb : vec2f,
  ta : f32,     // principal axes
  tb : f32,
  r : f32,      // farthest outline point of either, CSS px
};

fn ends(i : u32) -> Ends {
  var e : Ends;
  e.ka = u32(data(i, 0u));
  e.kb = u32(data(i, 4u));
  e.fa = gframe(e.ka);
  e.fb = gframe(e.kb);
  e.pa = from_uv(e.fa, tab(u32(data(i, 1u)) + 2u * u32(data(i, 3u))));
  e.pb = from_uv(e.fb, tab(u32(data(i, 5u)) + 2u * u32(data(i, 7u))));
  e.ta = data(i, 8u);
  e.tb = data(i, 9u);
  e.r = max(data(i, 10u) * length(e.fa.ax), data(i, 11u) * length(e.fb.ax));
  return e;
}

fn ease(x : f32) -> f32 {
  return select(1.0 - pow(-2.0 * x + 2.0, 3.0) * 0.5, 4.0 * x * x * x,
    x < 0.5);
}

// Pair i's own progress: staggered by its random over params.spread.
fn travel(i : u32, p : f32) -> f32 {
  let r = data(i, 12u);
  let s = params.spread;
  return ease(clamp(p * (1.0 + s) - r * s, 0.0, 1.0));
}

// The outline mix at travel t.
fn shape(t : f32) -> f32 {
  return smoothstep(params.swap - params.soft, params.swap + params.soft, t);
}

// The pair's frame at t: an outline point l (centred, unturned) sits at
// p + rot2(a, l).
struct Pose { p : vec2f, a : f32 };

// Each side's outline point j, centred and turned to its axis, CSS px:
// rot2(-axis) applied to the glyph's uv axes, times the stored offset.
fn side_map(f : GFrame, axis : f32) -> mat2x2f {
  return mat2x2f(rot2(-axis, f.ax), rot2(-axis, f.ay));
}

fn pt_a(i : u32, j : u32) -> vec2f {
  return vec2f(data(i, PAIR_HEAD + 2u * j), data(i, PAIR_HEAD + 2u * j + 1u));
}

fn pt_b(i : u32, j : u32) -> vec2f {
  let k = PAIR_HEAD + 2u * MPTS + 2u * j;
  return vec2f(data(i, k), data(i, k + 1u));
}

fn pose(i : u32, e : Ends, t : f32) -> Pose {
  let r = data(i, 12u);
  let d = e.pb - e.pa;
  let bend = sin(PI * t);
  var o : Pose;
  o.p = mix(e.pa, e.pb, t) +
    vec2f(-d.y, d.x) * bend * params.arc * (r - 0.5) * 2.0;
  o.a = mix(e.ta, e.tb, t) + params.spin * (fract(r * 13.7) - 0.5) * bend;
  return o;
}
`

const VERTEX = /* wgsl */ `${COMMON}
fn vertex(i : u32, corner : vec2f) -> Quad {
  var q : Quad;
  if (f32(i) >= params.pieces) {
    return q;
  }
  let e = ends(i);
  let tn = travel(i, params.progress);
  let tp = travel(i, params.prev);
  let now = pose(i, e, tn);
  let was = pose(i, e, tp);
  // Tight bounds: both outlines in the pair's frame (any mix of them
  // stays inside), grown by the blur reach and a pixel or two.
  let ma = side_map(e.fa, e.ta);
  let mb = side_map(e.fb, e.tb);
  var lo = vec2f(1e9);
  var hi = vec2f(-1e9);
  for (var j = 0u; j < MPTS; j++) {
    let a = ma * pt_a(i, j);
    let b = mb * pt_b(i, j);
    lo = min(lo, min(a, b));
    hi = max(hi, max(a, b));
  }
  let ext = max(abs(lo), abs(hi));
  let reach = (distance(now.p, was.p) + length(ext) * abs(now.a - was.a)) *
    params.blur * (1.0 + 2.0 * params.fringe);
  let m = vec2f(2.0 + reach);
  q.pos = now.p + rot2(now.a, mix(lo - m, hi + m, corner));
  q.uv = q.pos;
  let w = shape(tn);
  q.color = mix(glyph_color(e.ka), glyph_color(e.kb), w);
  q.extra = vec4f(tn, tp, w, 0.0);
  return q;
}
`

// COMMON rides in VERTEX: both hooks land in one module.
const FRAGMENT = /* wgsl */ `
fn fragment(q : Quad, i : u32) -> vec4f {
  let e = ends(i);
  let tn = q.extra.x;
  let tp = q.extra.y;
  // Derivatives first, in uniform control flow.
  let ua = to_uv(e.fa, q.uv);
  let ub = to_uv(e.fb, q.uv);
  let ia = 1.0 / max(fwidth(vec2f(ua.x, 1.0 - ua.y)), vec2f(1e-5));
  let ib = 1.0 / max(fwidth(vec2f(ub.x, 1.0 - ub.y)), vec2f(1e-5));
  let a = q.color.a;
  // At rest: the glyph's own chunk, as the text pass draws it.
  if (tn == tp && (tn == 0.0 || tn == 1.0)) {
    var c = 0.0;
    if (tn == 0.0) {
      c = slug(e.ka, ua, ia) * mine(ua, u32(data(i, 1u)),
        u32(data(i, 2u)), u32(data(i, 3u)), data(i, 13u));
    } else {
      c = slug(e.kb, ub, ib) * mine(ub, u32(data(i, 5u)),
        u32(data(i, 6u)), u32(data(i, 7u)), data(i, 14u));
    }
    return vec4f(q.color.rgb * c * a, c * a);
  }
  // In flight: the polygon mixed from both outlines, read edge by edge.
  let ma = side_map(e.fa, e.ta);
  let mb = side_map(e.fb, e.tb);
  let n = max(u32(params.taps), 1u);
  let f = params.fringe;
  var acc = vec3f(0.0);
  var cnt = vec3f(0.0);
  for (var k = 0u; k < n; k++) {
    var s = -0.5;
    var wt = vec3f(1.0);
    if (n > 1u) {
      s = mix(-0.5 - f, 0.5 + f, (f32(k) + 0.5) / f32(n));
      wt = vec3f(
        select(0.0, 1.0, abs(s + f) <= 0.5001),
        select(0.0, 1.0, abs(s) <= 0.5001),
        select(0.0, 1.0, abs(s - f) <= 0.5001));
    }
    // The polygon at a time across the last frame: pose and shape.
    let t = mix(tn, tp, (s + 0.5) * params.blur);
    let o = pose(i, e, t);
    let w = shape(t);
    let l = rot2(-o.a, q.uv - o.p);
    var wind = 0;
    var dmin = 1e9;
    var v0 = mix(ma * pt_a(i, MPTS - 1u), mb * pt_b(i, MPTS - 1u), w);
    for (var j = 0u; j < MPTS; j++) {
      let v1 = mix(ma * pt_a(i, j), mb * pt_b(i, j), w);
      let ed = v1 - v0;
      let rel = l - v0;
      let h = clamp(dot(rel, ed) / max(dot(ed, ed), 1e-8), 0.0, 1.0);
      dmin = min(dmin, length(rel - ed * h));
      let cr = ed.x * rel.y - ed.y * rel.x;
      if (v0.y <= l.y) {
        if (v1.y > l.y && cr > 0.0) {
          wind += 1;
        }
      } else if (v1.y <= l.y && cr < 0.0) {
        wind -= 1;
      }
      v0 = v1;
    }
    let sd = select(-dmin, dmin, wind != 0) * fx.dpr;
    let c = clamp(sd + 0.5, 0.0, 1.0);
    acc += c * wt;
    cnt += wt;
  }
  let cov = acc / max(cnt, vec3f(1.0));
  let m = max(cov.r, max(cov.g, cov.b)) * a;
  // One alpha for three coverages: make up the difference with the page
  // background assumed under the piece.
  let rgb = q.color.rgb * cov * a + params.bg.rgb * (m - cov * a);
  return vec4f(rgb, m);
}
`

// --- Page ----------------------------------------------------------------

const off = q.has('off')
const hide = fx.material({
  name: 'spike-hide',
  target: all,
  kinds: ['glyph'],
  hold: true,
  enabled: false,
  fragment: /* wgsl */ `
    fn fragment(m : MatIn) -> vec4f {
      return vec4f(0.0);
    }`
})

const timing = { ms: num('ms', 1100), hold: num('hold', 700) }
type Phase = 'hold' | 'run' | 'await'
let phase: Phase = 'hold'
let phaseAt = performance.now()
let paused = false
let built = ''
let awaitKey = ''

const layer: Layer = fx.layer({
  name: 'spike-segments',
  count: 0,
  stride: STRIDE,
  glyphs: all,
  place: 'above',
  enabled: !off,
  continuous: true,
  params: {
    progress: { type: 'f32', default: 0, min: 0, max: 1 },
    prev: { type: 'f32', default: 0, min: 0, max: 1 },
    pieces: { type: 'f32', default: 0 },
    spread: { type: 'f32', default: 0.5, min: 0, max: 2 },
    arc: { type: 'f32', default: 0.2, min: 0, max: 1 },
    spin: { type: 'f32', default: 0.4, min: 0, max: 4 },
    swap: { type: 'f32', default: 0.5, min: 0, max: 1 },
    soft: { type: 'f32', default: 0.5, min: 0.001, max: 0.5 },
    blur: { type: 'f32', default: num('blur', 0), min: 0, max: 4 },
    taps: { type: 'f32', default: num('taps', 1), min: 1, max: 8 },
    fringe: { type: 'f32', default: num('fringe', 0), min: 0, max: 0.5 },
    bg: { type: 'color', default: '#ffffff' }
  },
  vertex: VERTEX,
  fragment: FRAGMENT,
  update(l) {
    // An exception here would stop the compositor's frame loop: log it
    // (once per message) and keep going.
    try {
      step_(l)
    } catch (err) {
      const msg = String((err as Error)?.stack ?? err)
      if (!errors.has(msg)) {
        errors.add(msg)
        console.error('spike update:', err)
      }
    }
  }
})

const errors = new Set<string>()
function step_(l: Layer): void {
  const now = performance.now()
  const p = l.params as unknown as Record<string, number>
  p.prev = p.progress ?? 0
  if (!paused) {
    if (phase === 'hold' && now - phaseAt >= timing.hold) {
      phase = 'run'
      phaseAt = now
    }
    if (phase === 'run') {
      p.progress = Math.min(1, (now - phaseAt) / Math.max(timing.ms, 1))
      if (p.progress >= 1) {
        phase = 'await'
        phaseAt = now
        awaitKey = built
        step = (step + 1) % STRINGS.length
        setText()
      }
    }
  }
  rebuild(l)
  const flying = phase !== 'hold' && !blank.on
  p.pieces = flying ? pairs : 0
  if (hide.enabled !== flying) {
    hide.enabled = flying
  }
  drive(p.progress ?? 0)
  if (phase === 'await' && built !== awaitKey) {
    // The swapped text has been read: rest on the new outgoing string.
    phase = 'hold'
    phaseAt = now
    p.progress = 0
    p.prev = 0
  }
}

let pieces = Math.max(1, num('pieces', 16))
let pairs = 0
// The sweep's baseline: the loop running, the layer drawing nothing.
const blank = { on: false }

// (Re)build the pairs when the glyphs or the piece count change. Header
// (HEAD floats): old glyph k, table start, chunk count, chunk index; the
// same for the new glyph; old axis, new axis (nearest turn); old and new
// outline reach (ink-box widths); random; old and new ink aspect (h /
// w). Then the old outline and the aligned new one, M points each, in
// uv relative to their chunk's centroid.
// The centroid table (uv pairs) follows the pairs.
function rebuild(l: Layer): void {
  const versions = stages.map((s) => `${s.outT.version}.${s.inT.version}`)
  const key = `${pieces}:${inkFont}:${versions.join(',')}`
  if (key === built) {
    return
  }
  built = key
  const table: number[] = []
  const rows: Float32Array[] = []
  let k0 = 0
  let seed = 7
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  for (const s of stages) {
    const nA = s.outT.glyphs.count
    const A = side(s.outT, k0, pieces, table)
    const B = side(s.inT, k0 + nA, pieces, table)
    k0 += nA + s.inT.glyphs.count
    const n = Math.min(A.length, B.length)
    if (n === 0) {
      continue
    }
    const cost = new Float64Array(n * n)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = A[i]
        const b = B[j]
        const c = a && b ? (a.x - b.x) ** 2 + (a.y - b.y) ** 2 : 0
        cost[i * n + j] = Number.isFinite(c) ? c : 1e12
      }
    }
    const match = assign(cost, n)
    for (let i = 0; i < n; i++) {
      const a = A[i]
      const b = B[at(match, i)]
      if (!a || !b) {
        continue
      }
      // An axis is a line: take the new one's turn nearest the old.
      let tb = b.chunk.angle
      while (tb - a.chunk.angle > Math.PI / 2) {
        tb -= Math.PI
      }
      while (tb - a.chunk.angle < -Math.PI / 2) {
        tb += Math.PI
      }
      const shift = align(a, b, tb)
      const row = new Float32Array(STRIDE)
      row.set([
        a.k,
        a.start,
        a.count,
        a.me,
        b.k,
        b.start,
        b.count,
        b.me,
        a.chunk.angle,
        tb,
        a.chunk.r / a.ink.bw,
        b.chunk.r / b.ink.bw,
        rand(),
        a.ink.bh / a.ink.bw,
        b.ink.bh / b.ink.bw,
        0
      ])
      for (let j = 0; j < M; j++) {
        const jb = (j + shift) % M
        const al = a.chunk.loop
        const bl = b.chunk.loop
        row[HEAD + j * 2] = (at(al, j * 2) - a.chunk.cx) / a.ink.bw
        row[HEAD + j * 2 + 1] = (at(al, j * 2 + 1) - a.chunk.cy) / a.ink.bh
        row[HEAD + 2 * M + j * 2] = (at(bl, jb * 2) - b.chunk.cx) / b.ink.bw
        row[HEAD + 2 * M + j * 2 + 1] =
          (at(bl, jb * 2 + 1) - b.chunk.cy) / b.ink.bh
      }
      rows.push(row)
    }
  }
  const base = rows.length * STRIDE
  l.count = Math.max(1, Math.ceil((base + table.length) / STRIDE))
  pairs = rows.length
  const d = l.data
  d.fill(0)
  rows.forEach((r, i) => {
    r[1] = at(r, 1) + base
    r[5] = at(r, 5) + base
    d.set(r, i * STRIDE)
  })
  d.set(table, base)
  l.markDirty()
}

function setFont(): void {
  const cs = getComputedStyle(stageEls[0] ?? document.body)
  inkFont = `${cs.fontStyle} ${cs.fontWeight} ${RASTER}px ${cs.fontFamily}`
  inkCache.clear()
  chunkCache.clear()
}
setFont()
document.fonts.addEventListener('loadingdone', setFont)
document.fonts.ready.then(setFont)


// --- Post pass -----------------------------------------------------------

// The reference's look sits on the whole frame, not on the pieces: a
// bulge at the centre of the text when a morph starts, which then
// travels outward as a ring, slowly, fading as it goes. The ring
// magnifies what it passes over and carries a zoom blur and a red /
// blue split. A fullscreen pass over the composited scene, separate
// from the morph, on its own clock: it starts with each morph and can
// outlive it (`life`).
const POST = /* wgsl */ `
fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  let s = params.amount;
  if (s <= 0.0) {
    return sample(uv);
  }
  let css = fx.viewport / fx.dpr;
  let c = params.center * css;
  let d = uv * css - c;
  let r = length(d);
  // The ring: a gaussian of width around the front (at the centre when
  // the front is 0, so the wave starts as a bulge).
  let x = (r - params.front) / max(params.width, 1.0);
  let g = exp(-x * x);
  if (g < 0.004) {
    return sample(uv);
  }
  let ring = s * g;
  let q = c + d * (1.0 - params.bulge * ring);
  let zoom = params.zoom * ring;
  let split = params.split * ring;
  // Fringe: red and blue pulled apart along the radius by a fixed
  // distance on the ring (CSS px), so edges near the centre fringe too.
  let dir = select(vec2f(0.0), d / max(r, 1e-3), r > 1e-3);
  let fr = dir * params.fringe * ring;
  // Fewer taps where the ring is faint.
  let n = max(u32(ceil(params.taps * g)), 1u);
  var acc = vec4f(0.0);
  for (var j = 0u; j < n; j++) {
    var k = 0.0;
    if (n > 1u) {
      k = (f32(j) / f32(n - 1u) - 0.5) * zoom;
    }
    let cr = sample((c + (q - c) * (1.0 + k + split) + fr) / css);
    let cg = sample((c + (q - c) * (1.0 + k)) / css);
    let cb = sample((c + (q - c) * (1.0 + k - split) - fr) / css);
    acc += vec4f(cr.r, cg.g, cb.b, max(max(cr.a, cg.a), cb.a));
  }
  return acc / f32(n);
}
`

const post = fx.pass({
  name: 'spike-wave',
  radius: 48,
  enabled: false,
  params: {
    amount: { type: 'f32', default: 0, min: 0, max: 1 },
    center: { type: 'vec2', default: [0.5, 0.5] },
    front: { type: 'f32', default: 0, min: 0, max: 4000 },
    width: { type: 'f32', default: num('width', 140), min: 10, max: 800 },
    bulge: { type: 'f32', default: num('bulge', 0.22), min: 0, max: 0.9 },
    zoom: { type: 'f32', default: num('zoom', 0.08), min: 0, max: 0.4 },
    split: { type: 'f32', default: num('split', 0.03), min: 0, max: 0.1 },
    fringe: { type: 'f32', default: num('pfringe', 6), min: 0, max: 40 },
    taps: { type: 'f32', default: num('ptaps', 8), min: 1, max: 16 }
  },
  fragment: POST
})
let postOn = !off && !q.has('nopost')
const pp = post.params as unknown as Record<string, number | number[]>
// The wave's clock (page side): front speed in CSS px/s, how long it
// lives, and how fast it fades (e-folding time), seconds.
const wave = {
  speed: num('speed', 520),
  life: num('life', 2.2),
  decay: num('decay', 0.9),
  at: -1
}

// Starts with each morph (progress leaving 0).
let lastProgress = 0
function drive(progress: number): void {
  const now = performance.now()
  if (postOn && lastProgress === 0 && progress > 0) {
    wave.at = now
  }
  lastProgress = progress
  const age = wave.at < 0 ? Number.POSITIVE_INFINITY : (now - wave.at) / 1000
  const live = postOn && age < wave.life
  const amount = live
    ? Math.exp(-age / Math.max(wave.decay, 0.01)) *
      Math.min(1, age / 0.08) *
      (1 - Math.max(0, (age - wave.life * 0.8) / (wave.life * 0.2)))
    : 0
  pp.amount = amount
  pp.front = live ? age * wave.speed : 0
  if (amount > 0) {
    // The mirror's rect (doc space): no layout read in the frame.
    const r = all.rect
    pp.center = [
      (r.x + r.width / 2 - scrollX) / innerWidth,
      (r.y + r.height / 2 - scrollY) / innerHeight
    ]
  }
  if (post.enabled !== amount > 0) {
    post.enabled = amount > 0
  }
}

// --- Controls ------------------------------------------------------------

const panel = document.getElementById('panel') as HTMLElement
const knobs: [string, number, number, number][] = [
  ['pieces', 4, 48, 1],
  ['taps', 1, 8, 1],
  ['blur', 0, 4, 0.05],
  ['fringe', 0, 0.5, 0.01],
  ['spread', 0, 2, 0.05],
  ['arc', 0, 1, 0.01],
  ['spin', 0, 4, 0.05],
  ['swap', 0, 1, 0.01],
  ['soft', 0.001, 0.5, 0.001]
]
const params = layer.params as unknown as Record<string, number>
for (const [name, min, max, stepSize] of knobs) {
  const label = document.createElement('label')
  const input = document.createElement('input')
  const value = name === 'pieces' ? pieces : (params[name] ?? 0)
  Object.assign(input, {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(stepSize),
    value: String(value)
  })
  const out = document.createElement('span')
  out.textContent = input.value
  input.addEventListener('input', () => {
    if (name === 'pieces') {
      pieces = Number(input.value)
    } else {
      params[name] = Number(input.value)
    }
    out.textContent = input.value
  })
  label.append(name, input, out)
  panel.append(label)
}
const postKnobs: [string, number, number, number][] = [
  ['bulge', 0, 0.9, 0.01],
  ['width', 10, 800, 5],
  ['zoom', 0, 0.4, 0.005],
  ['split', 0, 0.1, 0.001],
  ['fringe', 0, 40, 0.5],
  ['taps', 1, 16, 1]
]
const waveKnobs: [keyof typeof wave, number, number, number][] = [
  ['speed', 50, 2000, 10],
  ['life', 0.2, 6, 0.1],
  ['decay', 0.05, 4, 0.05]
]
const postTitle = document.createElement('div')
postTitle.textContent = 'post'
postTitle.style.marginTop = '6px'
panel.append(postTitle)
for (const [name, min, max, stepSize] of postKnobs) {
  const label = document.createElement('label')
  const input = document.createElement('input')
  Object.assign(input, {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(stepSize),
    value: String(pp[name] ?? 0)
  })
  const out = document.createElement('span')
  out.textContent = input.value
  input.addEventListener('input', () => {
    pp[name] = Number(input.value)
    out.textContent = input.value
  })
  label.append(`${name}`, input, out)
  panel.append(label)
}
for (const [name, min, max, stepSize] of waveKnobs) {
  const label = document.createElement('label')
  const input = document.createElement('input')
  Object.assign(input, {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(stepSize),
    value: String(wave[name])
  })
  const out = document.createElement('span')
  out.textContent = input.value
  input.addEventListener('input', () => {
    wave[name] = Number(input.value)
    out.textContent = input.value
  })
  label.append(name, input, out)
  panel.append(label)
}
const scrub = document.createElement('label')
const scrubIn = document.createElement('input')
Object.assign(scrubIn, { type: 'range', min: '0', max: '1', step: '0.001' })
const pause = document.createElement('input')
pause.type = 'checkbox'
scrubIn.addEventListener('input', () => {
  paused = true
  pause.checked = true
  if (phase !== 'run') {
    phase = 'run'
  }
  layer.params.progress = Number(scrubIn.value)
})
scrub.append('scrub', scrubIn)
const pauseLabel = document.createElement('label')
pause.addEventListener('change', () => {
  paused = pause.checked
  phaseAt = performance.now() - (params.progress ?? 0) * timing.ms
})
pauseLabel.append('pause', pause)
panel.append(scrub, pauseLabel)

// --- Console helpers ---------------------------------------------------

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function measure(label: string, ms = 3000) {
  compositor.profile.start()
  await wait(ms)
  const r = await compositor.profile.stop()
  if (!r) {
    return { label }
  }
  return {
    label,
    frames: r.frames,
    dropped: r.dropped,
    late: r.late,
    gpuP50: r.gpu ? +r.gpu.total.p50.toFixed(3) : null,
    gpuP95: r.gpu ? +r.gpu.total.p95.toFixed(3) : null,
    cpuP95: +r.cpu.total.p95.toFixed(3),
    gpuTiming: r.gpuTiming
  }
}
async function sweep(ms = 3000) {
  const rows: Awaited<ReturnType<typeof measure>>[] = []
  const saved = { hold: timing.hold, pieces }
  timing.hold = 0
  const savedPostOn = postOn
  postOn = false
  blank.on = true
  await wait(300)
  rows.push(await measure('loop, nothing drawn', ms))
  blank.on = false
  postOn = savedPostOn
  const savedPost = postOn
  postOn = false
  for (const n of [8, 16, 32]) {
    pieces = n
    await wait(300)
    rows.push(await measure(`morph, pieces ${n}`, ms))
  }
  postOn = true
  pieces = 16
  for (const taps of [1, 4, 8, 16]) {
    pp.taps = taps
    await wait(300)
    rows.push(await measure(`morph 16 + post, taps ${taps}`, ms))
  }
  postOn = savedPost
  timing.hold = saved.hold
  pieces = saved.pieces
  console.table(rows)
  return rows
}

Object.assign(window, {
  __gpu: compositor,
  __fx: fx,
  __spike: { layer, hide, post, measure, sweep, timing }
})
