import type { Rect } from '../scene/records'
import type { Scene } from '../scene/scene'
import {
  type Item,
  type StackingContext,
  assignPaintOrder,
  contextZIndex,
  createsStackingContext
} from '../scene/stacking'
import type { Layer } from '../types'
import { clipRectFor, readBox, readImageRecord, readOpacity } from './styles'
import { readTextNode } from './textRuns'

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'])

/**
 * Walk a root subtree, populate the scene with box / image / text records,
 * and resolve paint order.
 *
 * Paint order follows a simplified CSS stacking-context model (see
 * scene/stacking.ts): the walk builds a tree of StackingContexts as it goes
 * (one getComputedStyle per element, threaded through), then
 * `assignPaintOrder` flattens it into each record's integer `z`. Effective
 * opacity (own × every ancestor's, with the walk root's own opacity ignored
 * — replace mode zeroes it to hide the DOM paint) is accumulated alongside
 * and written into each record as it's created.
 *
 * All layout reads happen here, in one pass, so the frame's write phase
 * touches no DOM. Deliberately synchronous and allocation-conscious.
 */
function intersect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b
  if (!b) return a
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  return {
    x: x1,
    y: y1,
    width: Math.max(0, x2 - x1),
    height: Math.max(0, y2 - y1)
  }
}

export function readSubtree(
  root: Element,
  scene: Scene,
  layers: Set<Layer>
): void {
  scene.clear()

  // Push `el`'s own box/image records (if any) into `target`, in document
  // order, tagging each with `opacity`. Used both for a context's own
  // records (which must land first in its items, see stacking.ts) and for
  // an in-flow (non-context-creating) element's records.
  const pushOwnRecords = (
    el: Element,
    s: CSSStyleDeclaration,
    clip: Rect | null,
    opacity: number,
    target: Item[]
  ): void => {
    if (layers.has('boxes')) {
      const box = readBox(el, s, scene.allocId())
      if (box) {
        box.clip = clip
        box.opacity = opacity
        scene.add(box)
        target.push(box)
      }
    }
    if (
      layers.has('images') &&
      (el.tagName === 'IMG' ||
        el.tagName === 'CANVAS' ||
        el.tagName === 'VIDEO')
    ) {
      const rec = readImageRecord(el, s, scene.allocId(), clip)
      if (rec) {
        rec.opacity = opacity
        scene.add(rec)
        target.push(rec)
      }
    }
  }

  const visit = (
    el: Element,
    clip: Rect | null,
    ctx: StackingContext,
    parentOpacity: number,
    isRoot: boolean
  ): void => {
    if (SKIP_TAGS.has(el.tagName)) return
    const s = getComputedStyle(el)

    const ownOpacity = isRoot ? 1 : readOpacity(s)
    const effectiveOpacity = parentOpacity * ownOpacity

    let childCtx = ctx
    if (!isRoot && createsStackingContext(s)) {
      childCtx = { z: contextZIndex(s), items: [], ownCount: 0 }
      pushOwnRecords(el, s, clip, effectiveOpacity, childCtx.items)
      childCtx.ownCount = childCtx.items.length
      ctx.items.push(childCtx)
    } else {
      pushOwnRecords(el, s, clip, effectiveOpacity, ctx.items)
    }

    // An element's own box is clipped by its ancestors; its content
    // (children and text) is additionally clipped by its own overflow.
    const own = clipRectFor(el, s)
    const childClip = own ? intersect(clip, own) : clip

    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        visit(child as Element, childClip, childCtx, effectiveOpacity, false)
      } else if (layers.has('text') && child.nodeType === Node.TEXT_NODE) {
        const run = readTextNode(
          child as Text,
          el,
          scene.allocId(),
          0, // fontId resolved by the text backend in a later stage
          0
        )
        if (run) {
          run.clip = childClip
          run.opacity = effectiveOpacity
          scene.add(run)
          childCtx.items.push(run)
        }
      }
    }
  }

  const rootCtx: StackingContext = { z: 0, items: [], ownCount: 0 }
  visit(root, null, rootCtx, 1, true)
  assignPaintOrder(rootCtx)
  scene.sort()
}
