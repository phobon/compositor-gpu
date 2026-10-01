import type {
  BoxRecord,
  Glyph,
  GlyphRun,
  ImageRecord,
  Rect,
  SceneRecord,
  Space
} from '../scene/records'
import type { Scene } from '../scene/scene'
import {
  assignPaintOrder,
  contextZIndex,
  createsStackingContext,
  type OpacityGroup,
  type StackingContext
} from '../scene/stacking'
import type { Layer } from '../types'
import { disposeBackgrounds, readBackgroundImage } from './backgrounds'
import {
  buildDecorationBoxes,
  type Decoration,
  propagateDecorations
} from './decorations'
import { IGNORE_ATTR } from './observer'
import {
  type GlyphRef,
  type OrdinalCache,
  type PseudoHost,
  type PseudoOut,
  paddingPlacement,
  readBeforeAfter,
  readMarker
} from './pseudo'
import {
  beginRead,
  boxInset,
  clipRectFor,
  readBox,
  readImageRecord,
  readOpacity,
  readShadows,
  setReadSpace,
  toDocRect
} from './styles'
import { disposeSvgImages, isInlineSvgRoot, readSvgRecord } from './svg'
import {
  beginTextRead,
  contentHeight,
  FAST_TEXT_READ,
  readTextNode
} from './textRuns'
import {
  affine,
  composeIndividual,
  composeLinear,
  hasTransform,
  type Mat2,
  type Placement,
  rectPlacement,
  solveLocalSize,
  solveTranslation,
  solveWidthGivenHeight
} from './transform'

// The reader: the only place DOM layout and computed style are read.
//
// A persistent element tree (one ElNode per element under the root) holds
// every record the last read produced, in document order. A full read
// rebuilds it; a partial read re-reads only the subtrees a mutation could
// have changed and splices them in. Either way the scene is then rebuilt
// from the tree on the CPU (flatten → assignPaintOrder → sort), with no DOM
// access.
//
// Transforms: every element carries the accumulated linear part of its
// ancestors' and its own computed `transform` (`ElNode.lin`, null for an
// identity chain). The measured rects are AABBs of the transformed boxes;
// under a non-identity chain the reader recovers each record's local
// (untransformed) size and full affine from its AABB (see transform.ts).
// Clip rects of transformed overflow ancestors stay AABBs — over-inclusive
// for rotated clippers, exact for scale/translate.
//
// Fixed positioning: an element with `position: fixed` whose containing
// block is the viewport (no ancestor traps it — see trapsFixed) starts a
// viewport-space subtree. Every record under it, its node rects and its
// clips are measured without the scroll offset (setReadSpace), and records
// carry `space: 'viewport'`, so scrolling still re-reads nothing. Ancestor
// clips don't apply across that boundary. A trapped fixed element behaves
// like an absolute one and stays in document space.

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'])

/** More boundaries than this in one frame → a full read is cheaper. */
export const MAX_BOUNDARIES = 8
const RECT_EPSILON = 0.01

type OwnRecord = BoxRecord | ImageRecord

/**
 * The records to append after the box for a background image. An image
 * whose painting area reaches into the border (background-clip:
 * border-box) paints under the border, so the box's border moves to a
 * second, border-only box drawn after the image; the first box (mutated
 * here) keeps the fill.
 */
function underBorder(
  own: readonly OwnRecord[],
  bg: ImageRecord,
  s: CSSStyleDeclaration,
  place: Placement,
  alloc: () => number
): OwnRecord[] {
  const box = own.find((r): r is BoxRecord => r.kind === 'box' && !r.shadow)
  const pad = boxInset(s, 'padding-box')
  const reaches =
    bg.local.w > place.local.w - pad[1] - pad[3] + 0.01 ||
    bg.local.h > place.local.h - pad[0] - pad[2] + 0.01
  if (!box?.border || !reaches) {
    return [bg]
  }
  const border: BoxRecord = {
    ...box,
    id: alloc(),
    fill: { r: 0, g: 0, b: 0, a: 0 },
    gradient: null
  }
  delete border.bgInset
  box.border = null
  return [bg, border]
}
const NO_RECORDS: readonly OwnRecord[] = []

export interface ElNode {
  kind: 'element'
  el: Element
  parent: ElNode | null
  /** Child elements, direct text-node runs and pseudo-element records
   * (`::marker`, `::before` first, `::after` last), in paint order. */
  kids: ElKid[]
  /** Border-box rect (in `space`). Read for every element: it is the
   * escalation check for a partial read. */
  rect: Rect
  /** Space of this node's rects, records and clips ('viewport' inside a
   * `position: fixed` subtree). */
  space: Space
  /** This element or an ancestor establishes the containing block for
   * `position: fixed` descendants (transform, filter, ...). */
  trapsFixed: boolean
  /** The element's own box and/or image record. */
  own: readonly OwnRecord[]
  isContext: boolean
  /** Declared z-index of the context, when isContext. */
  ctxZ: number
  /** Clip applied to the element's content (children + text). */
  childClip: Rect | null
  /** Own opacity (1 for the root, whose own is ignored). An element with
   * alpha < 1 is a context and becomes an opacity group; its records keep
   * opacity 1 and the group applies alpha once. */
  alpha: number
  /** `display: inline | contents`: the box is fragmented (or absent), so
   * its bounding rect doesn't bound its effect on layout outside it. */
  fragmented: boolean
  /** Computed `float` is not none. */
  float: boolean
  /** Accumulated linear transform (ancestors · own); null = identity. */
  lin: Mat2 | null
  /** text-decoration entries to thread into children's text (own +
   * propagated from ancestors, reset at an out-of-flow/atomic-inline
   * boundary — see decorations.ts). Null when nothing decorates here. */
  decor: Decoration[] | null
  /** Padding box of the containing block for absolutely positioned
   * content inside this element (its own when positioned/transformed). */
  cb: Placement
  /** A synthetic node wrapping a positioned pseudo-element's records. */
  pseudo?: boolean
}

export type ElKid = ElNode | GlyphRun | BoxRecord

function intersect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) {
    return b
  }
  if (!b) {
    return a
  }
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
  if (node.float) {
    out.push(node.rect)
  }
  for (const kid of node.kids) {
    if (kid.kind === 'element') {
      collectFloats(kid, out)
    }
  }
}

const floatsA: Rect[] = []
const floatsB: Rect[] = []
function sameFloats(a: ElNode, b: ElNode): boolean {
  floatsA.length = 0
  floatsB.length = 0
  collectFloats(a, floatsA)
  collectFloats(b, floatsB)
  if (floatsA.length !== floatsB.length) {
    return false
  }
  for (let i = 0; i < floatsA.length; i++) {
    const fa = floatsA[i]
    const fb = floatsB[i]
    if (!fa || !fb || !sameRect(fa, fb)) {
      return false
    }
  }
  return true
}

/**
 * Build the stacking-context tree from an element tree, exactly as a DOM
 * walk would: a context-creating element's own records land first in a new
 * context (see stacking.ts), otherwise in the current one; kids follow in
 * document order. `sink` sees every record once. Returns the opacity
 * groups (see stacking.ts). CPU only.
 */
export function flatten(
  root: ElNode,
  sink?: (record: SceneRecord) => void
): OpacityGroup[] {
  const visit = (node: ElNode, ctx: StackingContext): void => {
    let c = ctx
    if (node.isContext) {
      c = {
        z: node.ctxZ,
        items: [],
        ownCount: node.own.length,
        alpha: node.alpha
      }
      ctx.items.push(c)
    }
    for (const r of node.own) {
      c.items.push(r)
      sink?.(r)
    }
    for (const kid of node.kids) {
      if (kid.kind === 'element') {
        visit(kid, c)
      } else if (kid.kind === 'box') {
        c.items.push(kid)
        sink?.(kid)
      } else {
        // Underlines/overlines paint under the glyphs they decorate,
        // line-through over them.
        if (kid.decorations) {
          for (const d of kid.decorations) {
            c.items.push(d)
            sink?.(d)
          }
        }
        c.items.push(kid)
        sink?.(kid)
        if (kid.decorationsOver) {
          for (const d of kid.decorationsOver) {
            c.items.push(d)
            sink?.(d)
          }
        }
      }
    }
  }
  const rootCtx: StackingContext = { z: 0, items: [], ownCount: 0 }
  visit(root, rootCtx)
  return assignPaintOrder(rootCtx)
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
      if (!b && usable(cur)) {
        b = cur
      }
      if (cur === root) {
        break
      }
      cur = cur.parentElement
    }
    if (!cur) {
      continue // not under root
    }
    if (!b) {
      return null
    }
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
      if (p === root) {
        break
      }
      p = p.parentElement
    }
    if (!nested) {
      out.push(b)
      if (out.length > max) {
        return null
      }
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
  /** List-item ordinals, per list, for the current read (see pseudo.ts). */
  private ordinals: OrdinalCache = new Map()
  /** Elements visited (DOM-read) by the most recent read, incl. any work
   * discarded by an escalation. */
  readElements = 0
  /** Partial reads that completed without escalating. */
  partialReads = 0
  /** Elements with computed `position: sticky` in the current tree. Their
   * offset depends on scroll, so the compositor re-reads them (paint-only)
   * on scroll. */
  readonly stickies = new Set<Element>()
  /** An ancestor of the root traps fixed descendants (see trapsFixed). */
  private rootTrapsFixed = false

  constructor(
    private readonly root: Element,
    private readonly scene: Scene,
    private readonly layers: ReadonlySet<Layer>,
    /** Called when a lazily-loaded asset (a background-image) for `el`
     * finishes loading, so its subtree can be re-read and re-painted. */
    private readonly onAsset: (el: Element) => void
  ) {}

  /** Re-read the whole root subtree and rebuild the scene. */
  fullRead(): void {
    beginRead()
    beginTextRead()
    this.readElements = 0
    this.ordinals.clear()
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
   *
   * A boundary in `paintOnly` (the target of a running animation that can
   * only change paint — see DomSync.animatingScopes) skips the rect and
   * float checks: its measured AABB moves with its own transform while its
   * margin box, and so everything outside it, stays put.
   */
  partialRead(
    scopes: ReadonlySet<Element>,
    paintOnly?: ReadonlySet<Element>
  ): void {
    beginRead()
    beginTextRead()
    this.readElements = 0
    this.ordinals.clear()
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
    if (bounds.length === 0) {
      return
    }

    for (const el of this.stickies) {
      for (const b of bounds) {
        if (b.contains(el)) {
          this.stickies.delete(el)
          break
        }
      }
    }
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
        p === null,
        p ? p.lin : null,
        p ? p.decor : null,
        p ? p.cb : null
      )
      const trusted = paintOnly?.has(b) === true
      if (
        !fresh ||
        fresh.fragmented ||
        (!trusted &&
          (!sameRect(old.rect, fresh.rect) || !sameFloats(old, fresh)))
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

  /**
   * Sticky elements whose border box moved since they were last read (one
   * rect read each; call in the frame's read phase). Unstuck stickies scroll
   * with the document and need no re-read.
   */
  movedStickies(): Element[] {
    const out: Element[] = []
    if (this.stickies.size === 0) {
      return out
    }
    beginRead()
    for (const el of this.stickies) {
      const n = this.nodes.get(el)
      if (!el.isConnected || !n) {
        continue
      }
      setReadSpace(n.space)
      if (!sameRect(n.rect, toDocRect(el.getBoundingClientRect()))) {
        out.push(el)
      }
    }
    return out
  }

  /** Drop pending asset callbacks and the element tree. */
  destroy(): void {
    disposeBackgrounds(this)
    disposeSvgImages(this)
    this.tree = null
    this.nodes = new WeakMap()
  }

  private readAll(): void {
    this.stickies.clear()
    this.rootTrapsFixed = ancestorsTrapFixed(this.root)
    this.tree = this.readNode(this.root, null, null, true, null, null, null)
    this.rebuildScene()
  }

  private rebuildScene(): void {
    const scene = this.scene
    scene.clear()
    if (this.tree) {
      scene.groups = flatten(this.tree, (r) => scene.add(r))
    }
    scene.sort()
  }

  /** All DOM reads for `el` and its subtree. Registers every new node. */
  private readNode(
    el: Element,
    parent: ElNode | null,
    ancestorClip: Rect | null,
    isRoot: boolean,
    parentLin: Mat2 | null,
    parentDecor: Decoration[] | null,
    parentCb: Placement | null
  ): ElNode | null {
    if (SKIP_TAGS.has(el.tagName) || el.hasAttribute(IGNORE_ATTR)) {
      return null
    }
    this.readElements++
    const { scene, layers } = this
    const s = getComputedStyle(el)
    // Nothing in a display:none subtree renders (descendants can't opt
    // back in), so skip its per-glyph and pseudo reads entirely.
    const display = s.display
    if (display === 'none') {
      return null
    }
    const transformable = isTransformable(el, display)
    const position = s.position
    const parentSpace = parent ? parent.space : 'doc'
    const parentTraps = parent ? parent.trapsFixed : this.rootTrapsFixed
    // A fixed element on the viewport starts a viewport-space subtree;
    // ancestor clips don't reach it.
    const fixedRoot =
      position === 'fixed' && parentSpace === 'doc' && !parentTraps
    const space: Space = fixedRoot ? 'viewport' : parentSpace
    const clip = fixedRoot ? null : ancestorClip
    setReadSpace(space)
    if (position === 'sticky') {
      this.stickies.add(el)
    }
    const rect = toDocRect(el.getBoundingClientRect())
    const lin = composeLinear(
      parentLin,
      transformable ? composeIndividual(s) : null
    )
    const place = lin
      ? transformedPlacement(el, lin, rect)
      : rectPlacement(rect)
    const ownAlpha = readOpacity(s, el)
    const isContext =
      !isRoot && createsStackingContext(s, transformable, ownAlpha)
    const alpha = isContext ? Math.max(0, ownAlpha) : 1
    const decor = layers.has('text')
      ? propagateDecorations(el, s, parentDecor)
      : null
    // An inline svg root paints as one rasterised image; nothing inside its
    // subtree gets its own record (see svg.ts).
    const svgRoot = isInlineSvgRoot(el)

    let own = NO_RECORDS
    if (layers.has('boxes')) {
      // Outer shadows paint under the element's own background.
      const shadows = readShadows(s, rect, place, () => scene.allocId())
      for (const sh of shadows) {
        sh.clip = clip
      }
      const box = readBox(s, rect, scene.allocId(), place)
      if (box) {
        box.clip = clip
        own = [...shadows, box]
      } else if (shadows.length) {
        own = shadows
      }
    }
    if (
      layers.has('images') &&
      (el.tagName === 'IMG' ||
        el.tagName === 'CANVAS' ||
        el.tagName === 'VIDEO')
    ) {
      const rec = readImageRecord(el, s, rect, scene.allocId(), clip, place)
      if (rec) {
        own = own.length ? [...own, rec] : [rec]
      }
    }
    if (layers.has('images') && svgRoot) {
      const rec = readSvgRecord(
        el as SVGSVGElement,
        s,
        rect,
        scene.allocId(),
        clip,
        place,
        this,
        () => this.onAsset(el)
      )
      if (rec) {
        own = own.length ? [...own, rec] : [rec]
      }
    }
    if (layers.has('images') && s.backgroundImage !== 'none') {
      const bg = readBackgroundImage(
        el,
        s,
        scene.allocId(),
        clip,
        this,
        () => this.onAsset(el),
        place
      )
      if (bg) {
        own = [...own, ...underBorder(own, bg, s, place, () => scene.allocId())]
      }
    }
    if (layers.has('boxes') && s.boxShadow.includes('inset')) {
      // Inset shadows paint above the backgrounds, below the content.
      const inset = readShadows(s, rect, place, () => scene.allocId(), true)
      for (const sh of inset) {
        sh.clip = clip
      }
      if (inset.length) {
        own = [...own, ...inset]
      }
    }

    // An element's own box is clipped by its ancestors; its content
    // (children and text) is additionally clipped by its own overflow.
    const ownClip = clipRectFor(s, rect)
    const childClip = ownClip ? intersect(clip, ownClip) : clip
    const cb =
      parentCb === null ||
      s.position !== 'static' ||
      (transformable && hasTransform(s))
        ? paddingPlacement(s, place)
        : parentCb

    const node: ElNode = {
      kind: 'element',
      el,
      parent,
      kids: [],
      rect,
      space,
      trapsFixed: parentTraps || trapsFixed(s, transformable),
      own,
      isContext,
      ctxZ: isContext ? contextZIndex(s) : 0,
      childClip,
      alpha,
      // A svg root is a replaced element regardless of its computed
      // display (browsers default it to inline): its measured rect always
      // bounds its rasterised content, so it stays a usable partial-read
      // boundary (see selectBoundaries) instead of forcing mutations inside
      // it to escalate to its parent.
      fragmented: svgRoot
        ? false
        : display === 'inline' || display === 'contents',
      float: s.float !== 'none',
      lin,
      decor,
      cb
    }
    this.nodes.set(el, node)

    if (!svgRoot) {
      for (const child of el.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const kid = this.readNode(
            child as Element,
            node,
            childClip,
            false,
            lin,
            decor,
            cb
          )
          if (kid) {
            node.kids.push(kid)
          }
          setReadSpace(space) // a fixed child switched it
        } else if (layers.has('text') && child.nodeType === Node.TEXT_NODE) {
          const run = readTextNode(
            child as Text,
            s,
            scene.allocId(),
            0, // fontId resolved by the text backend in a later stage
            0,
            // Chunk rects are AABBs under a transform; split only upright.
            FAST_TEXT_READ && !lin
          )
          if (run) {
            if (lin) {
              transformGlyphs(run.glyphs, lin, s)
            }
            run.clip = childClip
            if (decor?.length) {
              const d = buildDecorationBoxes(run, decor, childClip, () =>
                scene.allocId()
              )
              if (d.under.length) {
                run.decorations = d.under
              }
              if (d.over.length) {
                run.decorationsOver = d.over
              }
            }
            node.kids.push(run)
          }
        }
      }
      if (layers.has('boxes') || layers.has('text')) {
        this.readPseudos(node, s, place, display)
      }
    }
    if (space === 'viewport') {
      tagViewport(node)
    }
    return node
  }

  /**
   * Splice `node`'s pseudo-elements into its kids (after they are read:
   * placement needs their glyphs): `::marker` then `::before` first,
   * `::after` last.
   */
  private readPseudos(
    node: ElNode,
    s: CSSStyleDeclaration,
    place: Placement,
    display: string
  ): void {
    const { scene, layers } = this
    const host: PseudoHost = {
      el: node.el,
      s,
      place,
      clip: node.childClip,
      cb: node.cb,
      boxes: layers.has('boxes'),
      text: layers.has('text'),
      alloc: () => scene.allocId()
    }
    const head: ElKid[] = []
    if (display === 'list-item') {
      const marker = readMarker(host, firstGlyph(node.kids), this.ordinals)
      if (marker) {
        head.push(...this.pseudoKids(node, marker))
      }
    }
    const before = readBeforeAfter(host, '::before', firstGlyph(node.kids))
    if (before) {
      head.push(...this.pseudoKids(node, before))
    }
    const after = readBeforeAfter(host, '::after', lastGlyph(node.kids))
    if (head.length) {
      node.kids.unshift(...head)
    }
    if (after) {
      node.kids.push(...this.pseudoKids(node, after))
    }
  }

  /** A pseudo's records as kids; a positioned one (a stacking context)
   * is wrapped in a synthetic context node. */
  private pseudoKids(node: ElNode, out: PseudoOut): ElKid[] {
    const ctx = out.context
    if (!ctx) {
      return out.items
    }
    const own: OwnRecord[] = []
    const kids: ElKid[] = []
    for (const r of out.items) {
      if (r.kind === 'box' && kids.length === 0) {
        own.push(r)
      } else {
        kids.push(r)
      }
    }
    return [
      {
        kind: 'element',
        el: node.el,
        parent: node,
        kids,
        rect: ctx.rect,
        space: node.space,
        trapsFixed: node.trapsFixed,
        own,
        isContext: true,
        ctxZ: ctx.z,
        childClip: node.childClip,
        alpha: ctx.alpha,
        fragmented: false,
        float: false,
        lin: node.lin,
        decor: null,
        cb: node.cb,
        pseudo: true
      }
    ]
  }
}

/**
 * Mark `node`'s own records, text runs (with decorations) and pseudo-element
 * records viewport-space. Element kids tag themselves as they are read.
 */
function tagViewport(node: ElNode): void {
  for (const r of node.own) {
    r.space = 'viewport'
  }
  for (const kid of node.kids) {
    if (kid.kind === 'element') {
      if (kid.pseudo) {
        tagViewport(kid)
      }
      continue
    }
    kid.space = 'viewport'
    if (kid.kind !== 'text') {
      continue
    }
    if (kid.decorations) {
      for (const d of kid.decorations) {
        d.space = 'viewport'
      }
    }
    if (kid.decorationsOver) {
      for (const d of kid.decorationsOver) {
        d.space = 'viewport'
      }
    }
  }
}

const TRAP_WILL_CHANGE =
  /(^|,)\s*(transform|translate|rotate|scale|perspective|filter)\s*(,|$)/

/**
 * Does this element establish the containing block for `position: fixed`
 * descendants (so they position — and scroll — like absolute ones)? A
 * transform, filter, backdrop-filter, perspective, the matching will-change
 * values, or paint/layout containment.
 */
function trapsFixed(s: CSSStyleDeclaration, transformable: boolean): boolean {
  if (transformable && hasTransform(s)) {
    return true
  }
  if (s.filter !== 'none' || s.perspective !== 'none') {
    return true
  }
  const bf = s.backdropFilter
  if (bf && bf !== 'none') {
    return true
  }
  if (transformable && TRAP_WILL_CHANGE.test(s.willChange)) {
    return true
  }
  const c = s.contain
  return c !== 'none' && /paint|layout|strict|content/.test(c)
}

/** Whether any ancestor of `root` traps fixed descendants. */
function ancestorsTrapFixed(root: Element): boolean {
  for (let p = root.parentElement; p; p = p.parentElement) {
    if (trapsFixed(getComputedStyle(p), true)) {
      return true
    }
  }
  return false
}

const XHTML = 'http://www.w3.org/1999/xhtml'
const REPLACED = new Set([
  'IMG',
  'VIDEO',
  'CANVAS',
  'IFRAME',
  'EMBED',
  'OBJECT',
  'INPUT',
  'TEXTAREA',
  'SELECT'
])

/** CSS transforms don't apply to non-replaced `display: inline` HTML
 * boxes: their `transform` and individual transform properties are then
 * treated as `none` (placement, stacking and containing block alike). */
function isTransformable(el: Element, display: string): boolean {
  if (display !== 'inline') {
    return true
  }
  return el.namespaceURI !== XHTML || REPLACED.has(el.tagName)
}

/** First glyph in document order under `kids` (skipping positioned
 * pseudo-elements), with its run. */
function firstGlyph(kids: readonly ElKid[]): GlyphRef | null {
  for (const kid of kids) {
    if (kid.kind === 'text') {
      const g = kid.glyphs[0]
      if (g) {
        return { g, run: kid }
      }
    } else if (kid.kind === 'element' && !kid.pseudo) {
      const r = firstGlyph(kid.kids)
      if (r) {
        return r
      }
    }
  }
  return null
}

/** Last glyph in document order under `kids` (see firstGlyph). */
function lastGlyph(kids: readonly ElKid[]): GlyphRef | null {
  for (let i = kids.length - 1; i >= 0; i--) {
    const kid = kids[i]
    if (!kid) {
      continue
    }
    if (kid.kind === 'text') {
      const g = kid.glyphs[kid.glyphs.length - 1]
      if (g) {
        return { g, run: kid }
      }
    } else if (kid.kind === 'element' && !kid.pseudo) {
      const r = lastGlyph(kid.kids)
      if (r) {
        return r
      }
    }
  }
  return null
}

/**
 * Local box of an element under a non-identity linear chain `lin`, from
 * its measured AABB `rect`. The size comes from the 2×2 AABB solve; when
 * that is ill-conditioned (near 45°) or fails, from the integer layout
 * size `offsetWidth/offsetHeight` (the AABB for non-HTML elements).
 */
function transformedPlacement(el: Element, lin: Mat2, rect: Rect): Placement {
  let size = solveLocalSize(lin, rect.width, rect.height)
  if (!size) {
    const h = el as Partial<HTMLElement>
    size =
      typeof h.offsetWidth === 'number' && typeof h.offsetHeight === 'number'
        ? [h.offsetWidth, h.offsetHeight]
        : [rect.width, rect.height]
  }
  const [w, hh] = size
  const [tx, ty] = solveTranslation(lin, w, hh, rect.x, rect.y)
  return { xform: affine(lin, tx, ty), local: { w, h: hh } }
}

/**
 * Re-derive each glyph's local line box and affine under `lin` (the text
 * node's parent element's chain). Glyph rects are AABBs too: the size comes
 * from the same 2×2 solve; when ill-conditioned, h is the font's content
 * area height (what an untransformed grapheme Range reports — see
 * textRuns.contentHeight) and w is solved from one AABB equation.
 */
function transformGlyphs(
  glyphs: Glyph[],
  lin: Mat2,
  s: CSSStyleDeclaration
): void {
  let fallbackH = -1
  for (const g of glyphs) {
    const r = g.rect
    let size = solveLocalSize(lin, r.width, r.height)
    if (!size) {
      if (fallbackH < 0) {
        fallbackH = contentHeight(s)
      }
      const w = solveWidthGivenHeight(lin, fallbackH, r.width, r.height)
      size = [w ?? r.width, fallbackH]
    }
    const [w, h] = size
    const [tx, ty] = solveTranslation(lin, w, h, r.x, r.y)
    g.xform = affine(lin, tx, ty)
    g.local = { w, h }
  }
}
