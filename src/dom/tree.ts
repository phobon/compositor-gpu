import type {
  BoxRecord,
  GlyphRun,
  ImageRecord,
  Rect,
  SceneRecord
} from '../scene/records'
import type { Scene } from '../scene/scene'
import {
  type StackingContext,
  assignPaintOrder,
  contextZIndex,
  createsStackingContext
} from '../scene/stacking'
import type { Layer } from '../types'
import {
  clipRectFor,
  readBox,
  readImageRecord,
  readOpacity,
  toDocRect
} from './styles'
import { readTextNode } from './textRuns'

// The reader: the only place DOM layout and computed style are read.
//
// A persistent element tree (one ElNode per element under the root) holds
// every record the last read produced, in document order. A full read
// rebuilds it; a partial read re-reads only the subtrees a mutation could
// have changed and splices them in. Either way the scene is then rebuilt
// from the tree on the CPU (flatten → assignPaintOrder → sort), with no DOM
// access.

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'])

/** More boundaries than this in one frame → a full read is cheaper. */
export const MAX_BOUNDARIES = 8
const RECT_EPSILON = 0.01

type OwnRecord = BoxRecord | ImageRecord
const NO_RECORDS: readonly OwnRecord[] = []

export interface ElNode {
  kind: 'element'
  el: Element
  parent: ElNode | null
  /** Child elements and direct text-node runs, in document order. */
  kids: (ElNode | GlyphRun)[]
  /** Border-box rect (doc space). Read for every element: it is the
   * escalation check for a partial read. */
  rect: Rect
  /** The element's own box and/or image record. */
  own: readonly OwnRecord[]
  isContext: boolean
  /** Declared z-index of the context, when isContext. */
  ctxZ: number
  /** Clip applied to the element's content (children + text). */
  childClip: Rect | null
  /** Effective opacity (own × ancestors; the root's own is ignored). */
  opacity: number
  /** `display: inline | contents`: the box is fragmented (or absent), so
   * its bounding rect doesn't bound its effect on layout outside it. */
  fragmented: boolean
  /** Computed `float` is not none. */
  float: boolean
}

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

function sameRect(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) <= RECT_EPSILON &&
    Math.abs(a.y - b.y) <= RECT_EPSILON &&
    Math.abs(a.width - b.width) <= RECT_EPSILON &&
    Math.abs(a.height - b.height) <= RECT_EPSILON
  )
}

/** Push the rects of every float in `node`'s subtree (incl. itself). */
function collectFloats(node: ElNode, out: Rect[]): void {
  if (node.float) out.push(node.rect)
  for (const kid of node.kids) {
    if (kid.kind === 'element') collectFloats(kid, out)
  }
}

const floatsA: Rect[] = []
const floatsB: Rect[] = []
function sameFloats(a: ElNode, b: ElNode): boolean {
  floatsA.length = 0
  floatsB.length = 0
  collectFloats(a, floatsA)
  collectFloats(b, floatsB)
  if (floatsA.length !== floatsB.length) return false
  for (let i = 0; i < floatsA.length; i++) {
    const fa = floatsA[i]
    const fb = floatsB[i]
    if (!fa || !fb || !sameRect(fa, fb)) return false
  }
  return true
}

/**
 * Build the stacking-context tree from an element tree, exactly as a DOM
 * walk would: a context-creating element's own records land first in a new
 * context (see stacking.ts), otherwise in the current one; kids follow in
 * document order. `sink` sees every record once. CPU only.
 */
export function flatten(
  root: ElNode,
  sink?: (record: SceneRecord) => void
): StackingContext {
  const visit = (node: ElNode, ctx: StackingContext): void => {
    let c = ctx
    if (node.isContext) {
      c = { z: node.ctxZ, items: [], ownCount: node.own.length }
      ctx.items.push(c)
    }
    for (const r of node.own) {
      c.items.push(r)
      sink?.(r)
    }
    for (const kid of node.kids) {
      if (kid.kind === 'element') {
        visit(kid, c)
      } else {
        c.items.push(kid)
        sink?.(kid)
      }
    }
  }
  const rootCtx: StackingContext = { z: 0, items: [], ownCount: 0 }
  visit(root, rootCtx)
  assignPaintOrder(rootCtx)
  return rootCtx
}

interface Linked<E> {
  parentElement: E | null
}

/**
 * Resolve re-read scopes (elements whose subtree must be re-read; see
 * observer.ts for how mutation records map to scopes) to boundary elements.
 *
 * - A scope not inside `root` (detached) is dropped: its removal was itself
 *   a childList mutation on an ancestor that is still attached.
 * - Otherwise the boundary is the nearest ancestor-or-self for which
 *   `usable` holds (has a node in the tree, and isn't fragmented).
 * - Boundaries nested inside another boundary are dropped.
 *
 * Returns null when a full read is needed instead: no usable ancestor, or
 * more than `max` boundaries remain. Generic over the parent link so it can
 * be exercised without a DOM.
 */
export function selectBoundaries<E extends Linked<E>>(
  scopes: Iterable<E>,
  root: E,
  usable: (e: E) => boolean,
  max = MAX_BOUNDARIES
): E[] | null {
  const found = new Set<E>()
  for (const scope of scopes) {
    let b: E | null = null
    let cur: E | null = scope
    while (cur) {
      if (!b && usable(cur)) b = cur
      if (cur === root) break
      cur = cur.parentElement
    }
    if (!cur) continue // not under root
    if (!b) return null
    found.add(b)
  }
  const out: E[] = []
  for (const b of found) {
    let nested = false
    let p = b === root ? null : b.parentElement
    while (p) {
      if (found.has(p)) {
        nested = true
        break
      }
      if (p === root) break
      p = p.parentElement
    }
    if (!nested) {
      out.push(b)
      if (out.length > max) return null
    }
  }
  return out
}

/**
 * Owns the element tree for one root and keeps a Scene in step with it.
 * Deliberately synchronous and allocation-conscious: runs per mutation.
 */
export class SceneReader {
  private tree: ElNode | null = null
  private nodes = new WeakMap<Element, ElNode>()
  /** Elements visited (DOM-read) by the most recent read, incl. any work
   * discarded by an escalation. */
  readElements = 0
  /** Partial reads that completed without escalating. */
  partialReads = 0

  constructor(
    private readonly root: Element,
    private readonly scene: Scene,
    private readonly layers: ReadonlySet<Layer>
  ) {}

  /** Re-read the whole root subtree and rebuild the scene. */
  fullRead(): void {
    this.readElements = 0
    this.readAll()
  }

  /**
   * Re-read only the subtrees under `scopes`, escalating to a full read
   * when that can't be shown sound.
   *
   * Soundness: in-flow layout outside a boundary B depends only on B's
   * margin box. B's own style is unchanged — childList/characterData scopes
   * are the mutated element itself, and an attribute change on T scopes to
   * T's parent — so an unchanged border-box rect means B's margin box, and
   * with it B's siblings and ancestors, didn't move. Two cases break that
   * inference and are guarded: a fragmented (inline / display:contents) B,
   * whose bounding rect can stay put while its fragments reflow — such
   * elements are never boundaries; and floats inside B, which can overhang
   * B and push later content — any change to their rects escalates.
   * Changes to the root's own size are caught by the root ResizeObserver,
   * which forces a full read.
   */
  partialRead(scopes: ReadonlySet<Element>): void {
    this.readElements = 0
    const tree = this.tree
    if (!tree) {
      this.readAll()
      return
    }
    const bounds = selectBoundaries<Element>(scopes, this.root, (e) => {
      const n = this.nodes.get(e)
      return n !== undefined && !n.fragmented
    })
    if (!bounds) {
      this.readAll()
      return
    }
    if (bounds.length === 0) return

    for (const b of bounds) {
      const old = this.nodes.get(b)
      if (!old) {
        this.readAll()
        return
      }
      const p = old.parent
      const fresh = this.readNode(
        b,
        p,
        p ? p.childClip : null,
        p ? p.opacity : 1,
        p === null
      )
      if (
        !fresh ||
        fresh.fragmented ||
        !sameRect(old.rect, fresh.rect) ||
        !sameFloats(old, fresh)
      ) {
        this.readAll()
        return
      }
      if (p) {
        const i = p.kids.indexOf(old)
        if (i < 0) {
          this.readAll()
          return
        }
        p.kids[i] = fresh
      } else {
        this.tree = fresh
      }
    }
    this.partialReads++
    this.rebuildScene()
  }

  private readAll(): void {
    this.tree = this.readNode(this.root, null, null, 1, true)
    this.rebuildScene()
  }

  private rebuildScene(): void {
    const scene = this.scene
    scene.clear()
    if (this.tree) flatten(this.tree, (r) => scene.add(r))
    scene.sort()
  }

  /** All DOM reads for `el` and its subtree. Registers every new node. */
  private readNode(
    el: Element,
    parent: ElNode | null,
    clip: Rect | null,
    parentOpacity: number,
    isRoot: boolean
  ): ElNode | null {
    if (SKIP_TAGS.has(el.tagName)) return null
    this.readElements++
    const { scene, layers } = this
    const s = getComputedStyle(el)
    const rect = toDocRect(el.getBoundingClientRect())
    const opacity = parentOpacity * (isRoot ? 1 : readOpacity(s))
    const isContext = !isRoot && createsStackingContext(s)

    let own = NO_RECORDS
    if (layers.has('boxes')) {
      const box = readBox(s, rect, scene.allocId())
      if (box) {
        box.clip = clip
        box.opacity = opacity
        own = [box]
      }
    }
    if (
      layers.has('images') &&
      (el.tagName === 'IMG' ||
        el.tagName === 'CANVAS' ||
        el.tagName === 'VIDEO')
    ) {
      const rec = readImageRecord(el, s, rect, scene.allocId(), clip)
      if (rec) {
        rec.opacity = opacity
        own = own.length ? [...own, rec] : [rec]
      }
    }

    // An element's own box is clipped by its ancestors; its content
    // (children and text) is additionally clipped by its own overflow.
    const ownClip = clipRectFor(s, rect)
    const childClip = ownClip ? intersect(clip, ownClip) : clip
    const display = s.display

    const node: ElNode = {
      kind: 'element',
      el,
      parent,
      kids: [],
      rect,
      own,
      isContext,
      ctxZ: isContext ? contextZIndex(s) : 0,
      childClip,
      opacity,
      fragmented: display === 'inline' || display === 'contents',
      float: s.float !== 'none'
    }
    this.nodes.set(el, node)

    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const kid = this.readNode(
          child as Element,
          node,
          childClip,
          opacity,
          false
        )
        if (kid) node.kids.push(kid)
      } else if (layers.has('text') && child.nodeType === Node.TEXT_NODE) {
        const run = readTextNode(
          child as Text,
          s,
          scene.allocId(),
          0, // fontId resolved by the text backend in a later stage
          0
        )
        if (run) {
          run.clip = childClip
          run.opacity = opacity
          node.kids.push(run)
        }
      }
    }
    return node
  }
}
