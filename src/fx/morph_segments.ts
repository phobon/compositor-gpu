import type { Quad } from '../text/slug/font'

// The CPU half of fx.morph's text segments (docs/EFFECTS.md, Morph):
// cutting a glyph's outline into compact segments across its strokes,
// pairing two strings' graphemes (LCS) and their segments (least total
// travel), all in plain numbers. Proven in playground/spike_morph.ts
// (docs/rd/experiments/2026-10-26-segment-morph.md); here the outline
// comes from the font (Slug's GlyphBands.outline), not a canvas fillText.
//
// Glyph space throughout: uv over the glyph's tight ink box, y down
// (what the Slug instance's rect spans).

/** Outline points per segment. */
export const SEGMENT_POINTS = 48
/** Raster size of the longer side of a glyph's ink box when cutting. */
const RASTER = 256
const PAD = 2

export interface Segment {
  /** Centroid, glyph uv. */
  cx: number
  cy: number
  /** Principal axis, radians, in the glyph's aspect-correct space (y
   * down). */
  angle: number
  /** SEGMENT_POINTS outline points (x, y), glyph uv, positive area in
   * aspect-correct space. */
  loop: Float32Array
  /** Ink pixels in it (for sharing out). */
  weight: number
}

/** A glyph cut into segments, with the centroids every cell test uses. */
export interface CutGlyph {
  segments: Segment[]
  /** Ink box height / width. */
  aspect: number
  /** Ink pixels in the whole glyph at the cut's raster size. */
  ink: number
}

interface Raster {
  w: number
  h: number
  alpha: Uint8Array
  /** Ink pixel coords (raster px), sampled every other pixel. */
  pts: Float32Array
  n: number
}

/** Rasterise an outline (normalised bbox, y up) into a RASTER-sized
 * mask with the ink box's aspect. */
function rasterise(outline: readonly Quad[], aspect: number): Raster | null {
  const w = aspect <= 1 ? RASTER : Math.max(8, Math.round(RASTER / aspect))
  const h = aspect <= 1 ? Math.max(8, Math.round(RASTER * aspect)) : RASTER
  const cw = w + PAD * 2
  const ch = h + PAD * 2
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(cw, ch)
      : Object.assign(document.createElement('canvas'), {
          width: cw,
          height: ch
        })
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null
  if (!ctx) {
    return null
  }
  const X = (u: number) => PAD + u * w
  const Y = (v: number) => PAD + (1 - v) * h
  const path = new Path2D()
  let lx = Number.NaN
  let ly = Number.NaN
  for (const q of outline) {
    if (q.x0 !== lx || q.y0 !== ly) {
      path.moveTo(X(q.x0), Y(q.y0))
    }
    path.quadraticCurveTo(X(q.cx), Y(q.cy), X(q.x1), Y(q.y1))
    lx = q.x1
    ly = q.y1
  }
  ctx.fillStyle = '#fff'
  ctx.fill(path, 'nonzero')
  const img = ctx.getImageData(0, 0, cw, ch).data
  const alpha = new Uint8Array(cw * ch)
  const pts: number[] = []
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const a = img[(y * cw + x) * 4 + 3] ?? 0
      alpha[y * cw + x] = a
      if (a > 127 && x % 2 === 0 && y % 2 === 0) {
        pts.push(x, y)
      }
    }
  }
  return { w: cw, h: ch, alpha, pts: new Float32Array(pts), n: pts.length / 2 }
}

const at = (a: ArrayLike<number>, i: number): number => a[i] ?? 0

const cutCache = new WeakMap<readonly Quad[], Map<string, CutGlyph>>()

/**
 * Cut a glyph outline into `k` segments: k-means of its ink, straight
 * cuts on the bisectors between centroids, each segment's outline the
 * 0.5 level of min(ink, distance to its cuts), traced by marching
 * squares (largest loop) and resampled to SEGMENT_POINTS. Deterministic;
 * cached per outline, aspect and k.
 */
export function cutGlyph(
  outline: readonly Quad[],
  aspect: number,
  k: number
): CutGlyph {
  const key = `${aspect.toFixed(4)}:${k}`
  let byKey = cutCache.get(outline)
  const hit = byKey?.get(key)
  if (hit) {
    return hit
  }
  const r = rasterise(outline, aspect)
  const out: CutGlyph = { segments: [], aspect, ink: r?.n ?? 0 }
  if (r && r.n > 0 && k > 0) {
    out.segments = kmeansSegments(r, Math.min(k, r.n))
  }
  if (!byKey) {
    byKey = new Map()
    cutCache.set(outline, byKey)
  }
  byKey.set(key, out)
  return out
}

function kmeansSegments(r: Raster, k: number): Segment[] {
  const { pts, n } = r
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
  const iw = r.w - PAD * 2
  const ih = r.h - PAD * 2
  const segs: Segment[] = []
  for (let c = 0; c < k; c++) {
    let xx = 0
    let yy = 0
    let xy = 0
    let m = 0
    for (let i = 0; i < n; i++) {
      if (at(own, i) !== c) {
        continue
      }
      const dx = at(pts, i * 2) - at(cx, c)
      const dy = at(pts, i * 2 + 1) - at(cy, c)
      xx += dx * dx
      yy += dy * dy
      xy += dx * dy
      m++
    }
    const loopPx = outline(r, cx, cy, c, k)
    const loop = new Float32Array(SEGMENT_POINTS * 2)
    for (let j = 0; j < SEGMENT_POINTS; j++) {
      loop[j * 2] = (at(loopPx, j * 2) - PAD) / iw
      loop[j * 2 + 1] = (at(loopPx, j * 2 + 1) - PAD) / ih
    }
    segs.push({
      cx: (at(cx, c) - PAD) / iw,
      cy: (at(cy, c) - PAD) / ih,
      angle: 0.5 * Math.atan2(2 * xy, xx - yy),
      loop,
      weight: m
    })
  }
  return segs
}

/** Segment c's outline in raster px: the 0.5 level of min(ink, signed
 * distance to the cuts), marching squares, largest loop, resampled. */
function outline(
  r: Raster,
  cx: Float64Array,
  cy: Float64Array,
  c: number,
  k: number
): Float32Array {
  const ox = at(cx, c)
  const oy = at(cy, c)
  const { w, h } = r
  const f = new Float32Array(w * h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const a = at(r.alpha, y * w + x) / 255
      if (a <= 0) {
        continue
      }
      const dc = (x - ox) ** 2 + (y - oy) ** 2
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
        sd = Math.min(sd, ((x - qx) ** 2 + (y - qy) ** 2 - dc) / (2 * len))
      }
      f[y * w + x] = Math.min(a, Math.min(1, Math.max(0, 0.5 + sd)))
    }
  }
  const pos = new Map<number, [number, number]>()
  const adj = new Map<number, number[]>()
  const val = (x: number, y: number) => at(f, y * w + x)
  const cross = (
    id: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ): number => {
    if (!pos.has(id)) {
      const a = val(x0, y0)
      const b = val(x1, y1)
      const t = (0.5 - a) / (b - a)
      pos.set(id, [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t])
    }
    return id
  }
  const link = (a: number, b: number): void => {
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
      if (tl !== tr) {
        es.push(T())
      }
      if (tr !== br) {
        es.push(R())
      }
      if (br !== bl) {
        es.push(B())
      }
      if (bl !== tl) {
        es.push(L())
      }
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
      const q = loop[(i + 1) % loop.length] ?? p
      area += p[0] * q[1] - q[0] * p[1]
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

/** SEGMENT_POINTS evenly spaced by length around a closed loop (a dot at
 * (ox, oy) when there is none). */
function resample(
  loop: [number, number][],
  ox: number,
  oy: number
): Float32Array {
  const M = SEGMENT_POINTS
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

/** Share `total` among weights (largest remainder; every positive weight
 * gets at least one while there are enough). */
export function share(weights: readonly number[], total: number): number[] {
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

/** Min-cost perfect matching of an n x n cost matrix (Hungarian, O(n^3)):
 * match[i] = the column row i takes. Non-finite costs count as huge. */
export function assign(cost: Float64Array, n: number): Int32Array {
  const u = new Float64Array(n + 1)
  const v = new Float64Array(n + 1)
  const p = new Int32Array(n + 1)
  const way = new Int32Array(n + 1)
  const c = (i: number, j: number): number => {
    const x = at(cost, i * n + j)
    return Number.isFinite(x) ? x : 1e15
  }
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
        const cur = c(i0 - 1, j - 1) - at(u, i0) - at(v, j)
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

/** Longest common subsequence of two grapheme lists: pairs (i, j) of
 * equal graphemes kept in order. */
export function lcs(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length
  const m = b.length
  const dp = new Uint16Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] =
        a[i] === b[j]
          ? at(dp, (i + 1) * (m + 1) + j + 1) + 1
          : Math.max(at(dp, (i + 1) * (m + 1) + j), at(dp, i * (m + 1) + j + 1))
    }
  }
  const out: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j])
      i++
      j++
    } else if (at(dp, (i + 1) * (m + 1) + j) >= at(dp, i * (m + 1) + j + 1)) {
      i++
    } else {
      j++
    }
  }
  return out
}

/** The cyclic shift of b's points that moves a's least (both given
 * centred and turned to their own axes, in the same units). */
export function bestShift(la: Float64Array, lb: Float64Array): number {
  const M = SEGMENT_POINTS
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
