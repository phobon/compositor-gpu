import type { ElNode } from '../dom/tree'
import type { PathRecord, RGBA } from '../scene/records'

// Vector svg shapes as plain data for morphing (M5d-3; docs/EFFECTS.md,
// Morph): an element's path records (the path pass's, so only svgs opted
// in with data-gpu-vector or data-gpu-morph) as polylines in viewport CSS
// px, and the resampling and alignment that pair two shapes' contours
// point to point. Pure: no DOM or GPU.

/** Points each contour is resampled to for a morph. */
export const MORPH_POINTS = 64

export interface PathShape {
  /** Per subpath: x y pairs, viewport CSS px. */
  contours: Float32Array[]
  /** Per subpath: closed. */
  closed: boolean[]
  /** sRGB 0..1 with alpha (unpremultiplied); null: none. */
  fill: number[] | null
  stroke: number[] | null
  /** CSS px. */
  strokeWidth: number
  evenOdd: boolean
}

// Record colours are sRGB-encoded 0..1 (parseColor), as the pass blends.
const srgb = (c: RGBA | null): number[] | null =>
  c ? [c.r, c.g, c.b, c.a] : null

/** One record as a shape, its points mapped to the viewport. */
export function shapeOf(
  r: PathRecord,
  scrollX: number,
  scrollY: number
): PathShape {
  const [a, b, c, d, e, f] = r.xform
  const ox = r.space === 'viewport' ? 0 : scrollX
  const oy = r.space === 'viewport' ? 0 : scrollY
  const contours: Float32Array[] = []
  const closed: boolean[] = []
  for (let k = 0; k + 2 < r.contours.length; k += 3) {
    const first = r.contours[k] ?? 0
    const count = r.contours[k + 1] ?? 0
    const out = new Float32Array(count * 2)
    for (let i = 0; i < count; i++) {
      const x = r.points[2 * (first + i)] ?? 0
      const y = r.points[2 * (first + i) + 1] ?? 0
      out[2 * i] = a * x + c * y + e - ox
      out[2 * i + 1] = b * x + d * y + f - oy
    }
    contours.push(out)
    closed.push(r.contours[k + 2] === 1)
  }
  return {
    contours,
    closed,
    fill: srgb(r.fill),
    stroke: srgb(r.stroke),
    strokeWidth: r.strokeWidth * Math.sqrt(Math.abs(a * d - b * c)),
    evenOdd: r.evenOdd
  }
}

/** The path records of `node`'s subtree, in paint order, as shapes. */
export function pathShapesOf(
  node: ElNode,
  scrollX: number,
  scrollY: number
): PathShape[] {
  const out: PathShape[] = []
  const visit = (n: ElNode): void => {
    for (const r of n.own) {
      if (r.kind === 'path') {
        out.push(shapeOf(r, scrollX, scrollY))
      }
    }
    for (const kid of n.kids) {
      if ('kids' in kid) {
        visit(kid)
      }
    }
  }
  visit(node)
  return out
}

/** `poly` resampled to `m` points evenly spaced along it (closed: round
 * the loop, so the last point is one step short of the first). */
export function resample(
  poly: Float32Array,
  closed: boolean,
  m = MORPH_POINTS
): Float32Array {
  const n = poly.length / 2
  const out = new Float32Array(m * 2)
  if (n === 0) {
    return out
  }
  const segs = closed ? n : n - 1
  const len: number[] = [0]
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n
    const dx = (poly[2 * j] ?? 0) - (poly[2 * i] ?? 0)
    const dy = (poly[2 * j + 1] ?? 0) - (poly[2 * i + 1] ?? 0)
    len.push((len[i] ?? 0) + Math.hypot(dx, dy))
  }
  const total = len[segs] ?? 0
  if (total <= 0 || segs <= 0) {
    for (let k = 0; k < m; k++) {
      out[2 * k] = poly[0] ?? 0
      out[2 * k + 1] = poly[1] ?? 0
    }
    return out
  }
  let s = 0
  for (let k = 0; k < m; k++) {
    const at = (total * k) / (closed ? m : m - 1)
    while (s < segs - 1 && (len[s + 1] ?? 0) < at) {
      s++
    }
    const l0 = len[s] ?? 0
    const l1 = len[s + 1] ?? l0
    const t = l1 > l0 ? (at - l0) / (l1 - l0) : 0
    const j = (s + 1) % n
    out[2 * k] = (poly[2 * s] ?? 0) * (1 - t) + (poly[2 * j] ?? 0) * t
    out[2 * k + 1] =
      (poly[2 * s + 1] ?? 0) * (1 - t) + (poly[2 * j + 1] ?? 0) * t
  }
  return out
}

export function centroid(poly: Float32Array): [number, number] {
  const n = poly.length / 2
  let x = 0
  let y = 0
  for (let i = 0; i < n; i++) {
    x += poly[2 * i] ?? 0
    y += poly[2 * i + 1] ?? 0
  }
  return n > 0 ? [x / n, y / n] : [0, 0]
}

/** Twice the signed area (positive: clockwise on screen). */
export function signedArea(poly: Float32Array): number {
  const n = poly.length / 2
  let s = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    s +=
      (poly[2 * i] ?? 0) * (poly[2 * j + 1] ?? 0) -
      (poly[2 * j] ?? 0) * (poly[2 * i + 1] ?? 0)
  }
  return s
}

/**
 * `b` (resampled, as `a`) reordered to pair with `a` point to point: for a
 * closed pair, turned to `a`'s winding direction (so a hole stays a hole)
 * and started where the points travel least, measured about each
 * contour's own centroid; an open one reversed if that travels less.
 */
export function align(
  a: Float32Array,
  b: Float32Array,
  closed: boolean
): Float32Array {
  const m = a.length / 2
  const rev = (p: Float32Array): Float32Array => {
    const o = new Float32Array(p.length)
    for (let i = 0; i < m; i++) {
      o[2 * i] = p[2 * (m - 1 - i)] ?? 0
      o[2 * i + 1] = p[2 * (m - 1 - i) + 1] ?? 0
    }
    return o
  }
  const [ax, ay] = centroid(a)
  const [bx, by] = centroid(b)
  const cost = (p: Float32Array, shift: number): number => {
    let s = 0
    for (let i = 0; i < m; i++) {
      const j = (i + shift) % m
      const dx = (p[2 * j] ?? 0) - bx - ((a[2 * i] ?? 0) - ax)
      const dy = (p[2 * j + 1] ?? 0) - by - ((a[2 * i + 1] ?? 0) - ay)
      s += dx * dx + dy * dy
    }
    return s
  }
  if (!closed) {
    const r = rev(b)
    return cost(r, 0) < cost(b, 0) ? r : b
  }
  const p = Math.sign(signedArea(a)) !== Math.sign(signedArea(b)) ? rev(b) : b
  let best = 0
  let bestCost = Number.POSITIVE_INFINITY
  for (let s = 0; s < m; s++) {
    const c = cost(p, s)
    if (c < bestCost) {
      bestCost = c
      best = s
    }
  }
  const out = new Float32Array(p.length)
  for (let i = 0; i < m; i++) {
    const j = (i + best) % m
    out[2 * i] = p[2 * j] ?? 0
    out[2 * i + 1] = p[2 * j + 1] ?? 0
  }
  return out
}

/** `m` copies of a point (a contour that appears from or shrinks to it). */
export function collapsed(
  x: number,
  y: number,
  m = MORPH_POINTS
): Float32Array {
  const out = new Float32Array(m * 2)
  for (let i = 0; i < m; i++) {
    out[2 * i] = x
    out[2 * i + 1] = y
  }
  return out
}
