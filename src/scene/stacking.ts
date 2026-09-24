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
import type { SceneRecord } from './records'

export interface StackingContext {
  /** Declared stacking level (the CSS z-index this context was created
   * with, or 0). Used only to order sibling contexts; never a paint index. */
  z: number
  items: Item[]
  /** items[0..ownCount) are the context-creating element's own box/image
   * records — always painted first, per Appendix E step 1. */
  ownCount: number
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
  const positioned = s.position !== 'static'
  if (positioned && s.zIndex !== 'auto') return true
  if (s.position === 'fixed' || s.position === 'sticky') return true
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

/**
 * DFS the context tree in paint order, assigning each record a unique,
 * increasing integer `z` (its global paint index). Sibling child contexts
 * are stably bucketed by sign of their declared z so within-bucket order
 * matches the tree/insertion order the walker built `items` in.
 */
export function assignPaintOrder(root: StackingContext): void {
  let counter = 0

  const visit = (ctx: StackingContext): void => {
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
      else item.z = counter++
    }
    for (const item of negative) visit(item)
    for (const item of inflow) item.z = counter++
    for (const item of zero) visit(item)
    for (const item of positive) visit(item)
  }

  visit(root)
}
