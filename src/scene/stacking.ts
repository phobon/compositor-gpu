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
import { hasTransform } from '../dom/transform'
import type { Glyph, GlyphRun, Rect, SceneRecord } from './records'

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
  /** Isolated for a region effect (gpu/graph.ts `isolate`): the context
   * becomes a group even at alpha 1, composited by the region's handler. */
  region?: number
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
  /** Doc-space union of the doc-space members' AABBs (nested groups
   * included); zero-size when there are none. */
  bounds: Rect
  /** Viewport-space union of the viewport-space members' AABBs (records in
   * a `position: fixed` subtree), or null when there are none. A group
   * inside a fixed element has only these; one containing a fixed element
   * has both. The renderer unions them at the current scroll. */
  vbounds: Rect | null
  /** 0 for a group not inside another group. */
  depth: number
  /** Set when the group isolates an element for a region effect: the
   * renderer composites it through that region's handler. */
  region?: number
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
 *
 * `transformable` is false for a non-replaced `display: inline` element:
 * CSS ignores its `transform` / `translate` / `rotate` / `scale` (and so
 * `will-change: transform`), which then create no context.
 */
export function createsStackingContext(
  s: CSSStyleDeclaration,
  transformable = true,
  opacity = Number.parseFloat(s.opacity)
): boolean {
  // Any positioned element: a real context when z-index is set, and the
  // documented z=0 pseudo-context (Appendix E step 6) when it's auto.
  if (s.position !== 'static') {
    return true
  }
  if (opacity < 1) {
    return true
  }
  if (transformable && hasTransform(s)) {
    return true
  }
  if (s.isolation === 'isolate') {
    return true
  }
  if (s.mixBlendMode !== 'normal') {
    return true
  }
  if (s.filter !== 'none') {
    return true
  }
  const wc = s.willChange
  if (/(^|,)\s*opacity\s*(,|$)/.test(wc)) {
    return true
  }
  if (
    transformable &&
    /(^|,)\s*(transform|translate|rotate|scale)\s*(,|$)/.test(wc)
  ) {
    return true
  }
  return false
}

/** The declared z-index for a new context, per the simplification above. */
export function contextZIndex(s: CSSStyleDeclaration): number {
  if (s.position === 'static' || s.zIndex === 'auto') {
    return 0
  }
  const n = Number.parseInt(s.zIndex, 10)
  return Number.isFinite(n) ? n : 0
}

interface Extent {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function emptyExtent(): Extent {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY
  }
}

function extentRect(e: Extent): Rect | null {
  if (!(e.maxX > e.minX && e.maxY > e.minY)) {
    return null
  }
  return {
    x: e.minX,
    y: e.minY,
    width: e.maxX - e.minX,
    height: e.maxY - e.minY
  }
}

/** Open-group bounds, one extent per coordinate space. */
interface Extents {
  doc: Extent
  vp: Extent
}

function growExtent(e: Extent, r: Rect): void {
  if (!(r.width > 0 && r.height > 0)) {
    return
  }
  e.minX = Math.min(e.minX, r.x)
  e.minY = Math.min(e.minY, r.y)
  e.maxX = Math.max(e.maxX, r.x + r.width)
  e.maxY = Math.max(e.maxY, r.y + r.height)
}

/**
 * Local-frame padding [x, y] that covers a run's `text-shadow` layers
 * around each glyph: the max over layers of `|offset| + 1.5·blur` (the
 * blur's 3σ tail) per axis. Null when the run has no shadows.
 */
export function textShadowPad(run: GlyphRun): [number, number] | null {
  const shadows = run.textShadows
  if (!shadows || shadows.length === 0) {
    return null
  }
  let px = 0
  let py = 0
  for (const s of shadows) {
    px = Math.max(px, Math.abs(s.ox) + 1.5 * s.blur)
    py = Math.max(py, Math.abs(s.oy) + 1.5 * s.blur)
  }
  return [px, py]
}

/** `g.rect` grown by `extra` + a local-frame pad (see textShadowPad); a
 * rotated/skewed glyph takes the larger pad on both axes. */
export function padGlyphRect(
  g: Glyph,
  pad: readonly [number, number] | null,
  extra = 0
): Rect {
  let px = pad ? pad[0] : 0
  let py = pad ? pad[1] : 0
  if (pad && (g.xform[1] !== 0 || g.xform[2] !== 0)) {
    px = py = Math.max(px, py)
  }
  px += extra
  py += extra
  const q = g.rect
  return {
    x: q.x - px,
    y: q.y - py,
    width: q.width + 2 * px,
    height: q.height + 2 * py
  }
}

/** Extend `e` by a record's paint bounds. Glyph line boxes are padded by
 * a quarter em (the ink box can overshoot a tight line-height) plus the
 * run's text-shadow extent. */
function growByRecord(es: Extents, r: SceneRecord): void {
  const e = r.space === 'viewport' ? es.vp : es.doc
  if (r.kind !== 'text') {
    growExtent(e, r.rect)
    return
  }
  const pad = textShadowPad(r)
  for (const g of r.glyphs) {
    growExtent(e, padGlyphRect(g, pad, g.fontSize * 0.25))
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
  const open: Extents[] = []

  const paint = (r: SceneRecord): void => {
    r.z = counter++
    const e = open[open.length - 1]
    if (e) {
      growByRecord(e, r)
    }
  }

  const visit = (ctx: StackingContext): void => {
    const alpha = ctx.alpha ?? 1
    if (alpha < 1 || ctx.region !== undefined) {
      const g: OpacityGroup = {
        first: counter,
        last: counter,
        alpha,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        vbounds: null,
        depth: open.length
      }
      if (ctx.region !== undefined) {
        g.region = ctx.region
      }
      groups.push(g)
      const e: Extents = { doc: emptyExtent(), vp: emptyExtent() }
      open.push(e)
      visitItems(ctx)
      open.pop()
      g.last = counter
      const parent = open[open.length - 1]
      const doc = extentRect(e.doc)
      if (doc) {
        g.bounds = doc
        if (parent) {
          growExtent(parent.doc, doc)
        }
      }
      g.vbounds = extentRect(e.vp)
      if (g.vbounds && parent) {
        growExtent(parent.vp, g.vbounds)
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
        if (item.z < 0) {
          negative.push(item)
        } else if (item.z > 0) {
          positive.push(item)
        } else {
          zero.push(item)
        }
      } else {
        inflow.push(item)
      }
    }
    negative.sort((a, b) => a.z - b.z)
    positive.sort((a, b) => a.z - b.z)

    for (const item of own) {
      if (isContext(item)) {
        visit(item)
      } else {
        paint(item)
      }
    }
    for (const item of negative) {
      visit(item)
    }
    for (const item of inflow) {
      paint(item)
    }
    for (const item of zero) {
      visit(item)
    }
    for (const item of positive) {
      visit(item)
    }
  }

  visit(root)
  return groups.filter((g) => g.last > g.first)
}
