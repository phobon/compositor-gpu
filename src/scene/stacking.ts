// Paint-order resolution: a simplified CSS stacking-context tree, built by
// the walker in one DOM pass, then flattened into integer `z` values on the
// scene records themselves (see records.ts: "global paint order").
//
// Ordering follows CSS 2.1 Appendix E, simplified to two item kinds (a
// record, or a nested context): within a context, the context-creating
// element's own box/image paint first, then negative z-index child
// contexts (ascending), then in-flow content in tree order, then z-index:0
// child contexts (incl. positioned z-index:auto, step 6) in tree order, then
// positive z-index child contexts (ascending).
import type { Rect, SceneRecord } from './records'

export interface StackingContext {
  /** Declared stacking level (the CSS z-index this context was created
   * with, or 0). Used only to order sibling contexts; never a paint index. */
  z: number
  items: Item[]
  /** items[0..ownCount) are the context-creating element's own box/image
   * records — always painted first, per Appendix E step 1. */
  ownCount: number
  /** The element's own opacity when < 1: the context is then an opacity
   * group (rendered offscreen, composited once). Absent/1 otherwise. */
  alpha?: number
}

/**
 * An isolated opacity group: the records with paint index in
 * [first, last) are drawn to an offscreen target at full opacity, then
 * composited once with `alpha`. Groups nest properly (a child's range lies
 * inside its parent's).
 */
export interface OpacityGroup {
  first: number
  /** Exclusive. */
  last: number
  alpha: number
  /** Doc-space union of the members' AABBs (nested groups included). */
  bounds: Rect
  /** 0 for a group not inside another group. */
  depth: number
}

export type Item = SceneRecord | StackingContext

function isContext(item: Item): item is StackingContext {
  return 'items' in item
}

/**
 * Does this element establish a new stacking context? Mirrors the CSS
 * conditions, read off an already-fetched computed style.
 *
 * Simplification: a positioned element with `z-index: auto` (including
 * `fixed`/`sticky`) is still treated as its own context, at z=0. CSS says
 * such an element's positioned descendants should instead escape into the
 * parent context; we accept that inaccuracy rather than model the distinct
 * "auto" case.
 */
export function createsStackingContext(s: CSSStyleDeclaration): boolean {
  // Any positioned element: a real context when z-index is set, and the
  // documented z=0 pseudo-context (Appendix E step 6) when it's auto.
  if (s.position !== 'static') return true
  if (Number.parseFloat(s.opacity) < 1) return true
  if (s.transform !== 'none') return true
  if (s.isolation === 'isolate') return true
  if (s.mixBlendMode !== 'normal') return true
  if (s.filter !== 'none') return true
  if (/(^|,)\s*(transform|opacity)\s*(,|$)/.test(s.willChange)) return true
  return false
}

/** The declared z-index for a new context, per the simplification above. */
export function contextZIndex(s: CSSStyleDeclaration): number {
  if (s.position === 'static' || s.zIndex === 'auto') return 0
  const n = Number.parseInt(s.zIndex, 10)
  return Number.isFinite(n) ? n : 0
}

interface Extent {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function growExtent(e: Extent, r: Rect): void {
  if (!(r.width > 0 && r.height > 0)) return
  e.minX = Math.min(e.minX, r.x)
  e.minY = Math.min(e.minY, r.y)
  e.maxX = Math.max(e.maxX, r.x + r.width)
  e.maxY = Math.max(e.maxY, r.y + r.height)
}

/** Extend `e` by a record's paint bounds. Glyph line boxes are padded by
 * a quarter em: the ink box can overshoot a tight line-height. */
function growByRecord(e: Extent, r: SceneRecord): void {
  if (r.kind !== 'text') {
    growExtent(e, r.rect)
    return
  }
  for (const g of r.glyphs) {
    const p = g.fontSize * 0.25
    const q = g.rect
    growExtent(e, {
      x: q.x - p,
      y: q.y - p,
      width: q.width + 2 * p,
      height: q.height + 2 * p
    })
  }
}

/**
 * DFS the context tree in paint order, assigning each record a unique,
 * increasing integer `z` (its global paint index). Sibling child contexts
 * are stably bucketed by sign of their declared z so within-bucket order
 * matches the tree/insertion order the walker built `items` in.
 *
 * Returns the opacity groups (contexts with `alpha < 1`) that contain at
 * least one record, sorted by `first` (a parent precedes its children).
 */
export function assignPaintOrder(root: StackingContext): OpacityGroup[] {
  let counter = 0
  const groups: OpacityGroup[] = []
  /** Bounds of the open groups, innermost last. */
  const open: Extent[] = []

  const paint = (r: SceneRecord): void => {
    r.z = counter++
    const e = open[open.length - 1]
    if (e) growByRecord(e, r)
  }

  const visit = (ctx: StackingContext): void => {
    const alpha = ctx.alpha ?? 1
    if (alpha < 1) {
      const g: OpacityGroup = {
        first: counter,
        last: counter,
        alpha,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        depth: open.length
      }
      groups.push(g)
      const e: Extent = {
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY
      }
      open.push(e)
      visitItems(ctx)
      open.pop()
      g.last = counter
      if (e.maxX > e.minX && e.maxY > e.minY) {
        g.bounds = {
          x: e.minX,
          y: e.minY,
          width: e.maxX - e.minX,
          height: e.maxY - e.minY
        }
        const parent = open[open.length - 1]
        if (parent) growExtent(parent, g.bounds)
      }
      return
    }
    visitItems(ctx)
  }

  const visitItems = (ctx: StackingContext): void => {
    const own = ctx.items.slice(0, ctx.ownCount)
    const rest = ctx.items.slice(ctx.ownCount)

    const negative: StackingContext[] = []
    const inflow: SceneRecord[] = []
    const zero: StackingContext[] = []
    const positive: StackingContext[] = []
    for (const item of rest) {
      if (isContext(item)) {
        if (item.z < 0) negative.push(item)
        else if (item.z > 0) positive.push(item)
        else zero.push(item)
      } else {
        inflow.push(item)
      }
    }
    negative.sort((a, b) => a.z - b.z)
    positive.sort((a, b) => a.z - b.z)

    for (const item of own) {
      if (isContext(item)) visit(item)
      else paint(item)
    }
    for (const item of negative) visit(item)
    for (const item of inflow) paint(item)
    for (const item of zero) visit(item)
    for (const item of positive) visit(item)
  }

  visit(root)
  return groups.filter((g) => g.last > g.first)
}
