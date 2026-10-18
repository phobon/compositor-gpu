// Layer-transform geometry in document space: affines, group extents and
// their mapped bounds. Pure (type-only imports), shared by the renderer
// and the effect snapshot.

import type { OpacityGroup } from '../scene/stacking'
import type { FrameContext } from '../types'
import type { LayerTransform } from './graph'

/** A doc-space affine [a, b, c, d, e, f]: (x, y) -> (a x + c y + e,
 * b x + d y + f). */
export type Affine = readonly [number, number, number, number, number, number]

export function apply(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

export function invert(m: Affine): Affine | null {
  const det = m[0] * m[3] - m[1] * m[2]
  if (Math.abs(det) < 1e-9) {
    return null
  }
  const a = m[3] / det
  const b = -m[1] / det
  const c = -m[2] / det
  const d = m[0] / det
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])]
}

/** `t` as a doc-space affine about its origin in the group's box, or null
 * when it is the identity (or the group has no box). */
export function layerAffine(
  g: OpacityGroup,
  t: LayerTransform,
  ctx: FrameContext
): Affine | null {
  const sx = Number.isFinite(t.scaleX) ? t.scaleX : 1
  const sy = Number.isFinite(t.scaleY) ? t.scaleY : 1
  const rot = Number.isFinite(t.rotate) ? t.rotate : 0
  const tx = Number.isFinite(t.x) ? t.x : 0
  const ty = Number.isFinite(t.y) ? t.y : 0
  if (tx === 0 && ty === 0 && sx === 1 && sy === 1 && rot % 360 === 0) {
    return null
  }
  const box = g.box
  if (!box) {
    return null
  }
  const vx = g.space === 'viewport' ? ctx.scrollX : 0
  const vy = g.space === 'viewport' ? ctx.scrollY : 0
  const ox =
    box.x + vx + (Number.isFinite(t.originX) ? t.originX : 0.5) * box.width
  const oy =
    box.y + vy + (Number.isFinite(t.originY) ? t.originY : 0.5) * box.height
  const r = (rot * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const a = cos * sx
  const b = sin * sx
  const c = -sin * sy
  const d = cos * sy
  return [a, b, c, d, ox + tx - (a * ox + c * oy), oy + ty - (b * ox + d * oy)]
}

export type Box4 = [number, number, number, number]

/** Resolution bounds for a transformed group's texture, relative to its
 * parent's: rendered at the transform's own scale (as a browser
 * re-rasters a scaled layer), so text and edges stay crisp scaled down or
 * up and the composite samples about 1:1. */
const MIN_RES = 1 / 16
const MAX_RES = 4

/** `m`'s axis scales (the lengths the unit x and y axes map to), clamped
 * to [MIN_RES, MAX_RES]. */
export function axisScales(m: Affine): [number, number] {
  const c = (v: number) => Math.min(MAX_RES, Math.max(MIN_RES, v))
  return [c(Math.hypot(m[0], m[1])), c(Math.hypot(m[2], m[3]))]
}

/** A layer transform's opacity in [0, 1] (1 when not a number). */
export function layerAlpha(t: LayerTransform): number {
  return Number.isFinite(t.opacity) ? Math.min(1, Math.max(0, t.opacity)) : 1
}

/** `g`'s doc-space extent at the current scroll (viewport-space members
 * at their viewport rect + scroll), or null when empty. */
export function groupExtent(g: OpacityGroup, ctx: FrameContext): Box4 | null {
  let bx0 = Number.POSITIVE_INFINITY
  let by0 = Number.POSITIVE_INFINITY
  let bx1 = Number.NEGATIVE_INFINITY
  let by1 = Number.NEGATIVE_INFINITY
  const d = g.bounds
  if (d.width > 0 && d.height > 0) {
    bx0 = d.x
    by0 = d.y
    bx1 = d.x + d.width
    by1 = d.y + d.height
  }
  const v = g.vbounds
  if (v) {
    bx0 = Math.min(bx0, v.x + ctx.scrollX)
    by0 = Math.min(by0, v.y + ctx.scrollY)
    bx1 = Math.max(bx1, v.x + v.width + ctx.scrollX)
    by1 = Math.max(by1, v.y + v.height + ctx.scrollY)
  }
  return bx1 > bx0 && by1 > by0 ? [bx0, by0, bx1, by1] : null
}

/** AABB of `m` applied to the rect (x0, y0)-(x1, y1). */
export function mapRect(
  m: Affine,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): [number, number, number, number] {
  const p = [
    apply(m, x0, y0),
    apply(m, x1, y0),
    apply(m, x0, y1),
    apply(m, x1, y1)
  ]
  return [
    Math.min(...p.map((q) => q[0])),
    Math.min(...p.map((q) => q[1])),
    Math.max(...p.map((q) => q[0])),
    Math.max(...p.map((q) => q[1]))
  ]
}
