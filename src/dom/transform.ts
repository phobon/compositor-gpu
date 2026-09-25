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

/** The transform-related computed properties (`translate` / `rotate` /
 * `scale` may be missing in older engines). */
export interface TransformStyle {
  transform: string
  translate?: string
  rotate?: string
  scale?: string
}

const set = (v: string | undefined): boolean => !!v && v !== 'none'

/** Does the style apply any transform (`transform` or an individual
 * `translate` / `rotate` / `scale` property)? */
export function hasTransform(s: TransformStyle): boolean {
  return set(s.transform) || set(s.translate) || set(s.rotate) || set(s.scale)
}

const ANGLE = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(deg|rad|turn|grad)$/i

function angleRad(tok: string): number | null {
  const m = ANGLE.exec(tok)
  if (!m) return null
  const n = Number.parseFloat(m[1] ?? '')
  const unit = (m[2] ?? '').toLowerCase()
  if (unit === 'deg') return (n * Math.PI) / 180
  if (unit === 'grad') return (n * Math.PI) / 200
  if (unit === 'turn') return n * 2 * Math.PI
  return n
}

/**
 * Linear part of a computed `rotate` value (`30deg`, `z 30deg`, `x 30deg`,
 * `1 1 0 30deg`), or null for none/identity/unparsable. A rotation about
 * any axis is projected to its 2D part, like matrix3d in parseTransform.
 */
function parseRotate(v: string | undefined): Mat2 | null {
  if (!set(v)) return null
  const toks = (v as string).trim().split(/\s+/)
  const theta = angleRad(toks[toks.length - 1] ?? '')
  if (theta === null || theta === 0) return null
  let x = 0
  let y = 0
  let z = 1
  if (toks.length === 2) {
    const axis = toks[0]
    x = axis === 'x' ? 1 : 0
    y = axis === 'y' ? 1 : 0
    z = axis === 'z' ? 1 : 0
    if (x + y + z === 0) return null
  } else if (toks.length === 4) {
    x = Number.parseFloat(toks[0] ?? '')
    y = Number.parseFloat(toks[1] ?? '')
    z = Number.parseFloat(toks[2] ?? '')
    const len = Math.hypot(x, y, z)
    if (!Number.isFinite(len) || len === 0) return null
    x /= len
    y /= len
    z /= len
  } else if (toks.length !== 1) {
    return null
  }
  // rotate3d(x, y, z, θ): the upper-left 2×2 of its matrix.
  const c = Math.cos(theta)
  const sn = Math.sin(theta)
  const t = 1 - c
  return [
    1 + t * (x * x - 1),
    z * sn + x * y * t,
    -z * sn + x * y * t,
    1 + t * (y * y - 1)
  ]
}

/** One computed `scale` component (a number, or a percentage). */
function scaleFactor(tok: string | undefined): number {
  if (tok === undefined) return Number.NaN
  const n = Number.parseFloat(tok)
  return tok.endsWith('%') ? n / 100 : n
}

/** Linear part of a computed `scale` value (`1.2`, `1.2 0.8`, with an
 * optional z factor that is dropped), or null for none/identity. */
function parseScale(v: string | undefined): Mat2 | null {
  if (!set(v)) return null
  const toks = (v as string).trim().split(/\s+/)
  const sx = scaleFactor(toks[0])
  const sy = toks.length > 1 ? scaleFactor(toks[1]) : sx
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return null
  if (sx === 1 && sy === 1) return null
  return [sx, 0, 0, sy]
}

/**
 * Linear part of an element's full transform: CSS applies
 * `translate · rotate · scale · transform` (all about the same origin).
 * `translate` has no linear part — the translation is always solved from
 * the measured AABB — so it only matters to `hasTransform`.
 */
export function composeIndividual(s: TransformStyle): Mat2 | null {
  return composeLinear(
    composeLinear(parseRotate(s.rotate), parseScale(s.scale)),
    parseTransform(s.transform)
  )
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
