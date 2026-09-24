// 2D affine transforms for the reader. Pure functions, no DOM access.
//
// `getBoundingClientRect()` / Range rects of a transformed element are the
// axis-aligned bounding box (AABB) of its transformed border box. The reader
// recovers the full affine T (local border-box coords -> document space)
// from that AABB plus the accumulated linear part of the transform chain:
// the linear part comes from computed `transform` matrices, the translation
// from the AABB, and the untransformed size from a 2×2 solve.

/** Linear part [a, b, c, d]: x' = a x + c y, y' = b x + d y. */
export type Mat2 = [number, number, number, number]

/** Column-major 2×3 affine [a, b, c, d, tx, ty]: doc = lin · local + t. */
export type Affine = [number, number, number, number, number, number]

/** Below this, |a||d| − |b||c| makes the size solve ill-conditioned (e.g.
 * near-45° rotations, where both AABB equations say the same thing). */
const MIN_DET = 0.2

/**
 * Linear part of a computed `transform` value, or null for identity.
 * `matrix3d(...)` is projected to its 2D affine (m11, m12, m21, m22):
 * perspective and z terms are dropped, so 3D transforms render flattened.
 */
export function parseTransform(s: string): Mat2 | null {
  if (!s || s === 'none') return null
  const m = /^(matrix|matrix3d)\(([^)]*)\)$/.exec(s.trim())
  if (!m) return null
  const v = (m[2] ?? '').split(',').map((t) => Number.parseFloat(t))
  let lin: Mat2
  if (m[1] === 'matrix') {
    if (v.length !== 6) return null
    lin = [v[0] ?? 1, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1]
  } else {
    if (v.length !== 16) return null
    lin = [v[0] ?? 1, v[1] ?? 0, v[4] ?? 0, v[5] ?? 1]
  }
  if (!lin.every(Number.isFinite)) return null
  if (lin[0] === 1 && lin[1] === 0 && lin[2] === 0 && lin[3] === 1) {
    return null
  }
  return lin
}

/** parent · own, treating null as identity (null result = identity). */
export function composeLinear(
  parent: Mat2 | null,
  own: Mat2 | null
): Mat2 | null {
  if (!parent) return own
  if (!own) return parent
  const [pa, pb, pc, pd] = parent
  const [oa, ob, oc, od] = own
  return [
    pa * oa + pc * ob,
    pb * oa + pd * ob,
    pa * oc + pc * od,
    pb * oc + pd * od
  ]
}

/**
 * Untransformed size [w, h] whose image under `lin` has an AABB of
 * aabbW × aabbH: solves |a|w + |c|h = W, |b|w + |d|h = H. Null when
 * ill-conditioned or the solution is negative / not finite.
 */
export function solveLocalSize(
  lin: Mat2,
  aabbW: number,
  aabbH: number
): [number, number] | null {
  const a = Math.abs(lin[0])
  const b = Math.abs(lin[1])
  const c = Math.abs(lin[2])
  const d = Math.abs(lin[3])
  const det = a * d - b * c
  if (Math.abs(det) <= MIN_DET) return null
  const w = (aabbW * d - c * aabbH) / det
  const h = (a * aabbH - b * aabbW) / det
  // Tiny negatives are float noise on a degenerate (zero-size) axis.
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null
  if (w < -0.5 || h < -0.5) return null
  return [Math.max(0, w), Math.max(0, h)]
}

/**
 * Local width for a known local height `h` from whichever AABB equation
 * has the larger width coefficient. Null when neither can determine it.
 */
export function solveWidthGivenHeight(
  lin: Mat2,
  h: number,
  aabbW: number,
  aabbH: number
): number | null {
  const a = Math.abs(lin[0])
  const b = Math.abs(lin[1])
  const c = Math.abs(lin[2])
  const d = Math.abs(lin[3])
  const w = a >= b ? (aabbW - c * h) / a : (aabbH - d * h) / b
  if (!Number.isFinite(w)) return null
  return Math.max(0, w)
}

/** Translation t so that the AABB of lin·[0,w]×[0,h] + t starts at
 * (aabbMinX, aabbMinY). */
export function solveTranslation(
  lin: Mat2,
  w: number,
  h: number,
  aabbMinX: number,
  aabbMinY: number
): [number, number] {
  const [a, b, c, d] = lin
  // min over the corners (0,0),(w,0),(0,h),(w,h) of each coordinate.
  const minX = Math.min(0, a * w) + Math.min(0, c * h)
  const minY = Math.min(0, b * w) + Math.min(0, d * h)
  return [aabbMinX - minX, aabbMinY - minY]
}

/** Assemble an affine from a linear part (null = identity) and t. */
export function affine(lin: Mat2 | null, tx: number, ty: number): Affine {
  return lin ? [lin[0], lin[1], lin[2], lin[3], tx, ty] : [1, 0, 0, 1, tx, ty]
}

/** Map a local point through an affine. */
export function applyAffine(t: Affine, x: number, y: number): [number, number] {
  return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]]
}

/** Where a record's local box sits: its affine and untransformed size. */
export interface Placement {
  xform: Affine
  local: { w: number; h: number }
}

/** The untransformed placement of a doc-space rect. */
export function rectPlacement(r: {
  x: number
  y: number
  width: number
  height: number
}): Placement {
  return {
    xform: [1, 0, 0, 1, r.x, r.y],
    local: { w: r.width, h: r.height }
  }
}

/**
 * Placement of the sub-rect (x, y, w, h) of `p`'s local box, as its own
 * local box: same linear part, origin moved to (x, y).
 */
export function subPlacement(
  p: Placement,
  x: number,
  y: number,
  w: number,
  h: number
): Placement {
  const [a, b, c, d, tx, ty] = p.xform
  return {
    xform: [a, b, c, d, tx + a * x + c * y, ty + b * x + d * y],
    local: { w, h }
  }
}

/** Doc-space AABB of a placement's local box. */
export function placementAabb(p: Placement): {
  x: number
  y: number
  width: number
  height: number
} {
  const [a, b, c, d, tx, ty] = p.xform
  const { w, h } = p.local
  const minX = Math.min(0, a * w) + Math.min(0, c * h)
  const maxX = Math.max(0, a * w) + Math.max(0, c * h)
  const minY = Math.min(0, b * w) + Math.min(0, d * h)
  const maxY = Math.max(0, b * w) + Math.max(0, d * h)
  return { x: tx + minX, y: ty + minY, width: maxX - minX, height: maxY - minY }
}
