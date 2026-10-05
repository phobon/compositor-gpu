import type { ElNode } from '../dom/tree'
import type { RenderGraph } from '../gpu/graph'
import type { Affine, Corners, GlyphRun, Rect } from '../scene/records'

// Targets: an element as a handle on the mirror's geometry
// (docs/EFFECTS.md "Targets"). Resolved lazily from the reader's node for
// the element, again whenever the scene has been rebuilt since.

/** Glyphs of a Target's subtree, in DOM order. Index i is stable across
 * re-reads while the text is unchanged. */
export interface TargetGlyphs {
  count: number
  /** x, y, width, height per glyph (its line box), in the target's space,
   * CSS px. */
  rects: Float32Array
  /** Font glyph index per glyph (the text backend's id). */
  ids: Uint32Array
  /** The grapheme painted for each glyph. */
  text: string[]
}

export interface Target {
  readonly el: Element
  /** False when the element has no node in the mirror (outside the root,
   * `display: none`, or before the first read). */
  readonly found: boolean
  /** Border-box AABB in `space`, CSS px (zero rect when not found). */
  readonly rect: Rect
  /** Untransformed border-box size. */
  readonly local: { w: number; h: number }
  /** Local box (origin top-left) -> `space`. */
  readonly xform: Affine
  /** 'viewport' inside a `position: fixed` subtree, else 'doc'. */
  readonly space: 'doc' | 'viewport'
  /** Border radii (tl, tr, br, bl), CSS px, from the element's own box;
   * zeros when it paints none. */
  readonly radius: Corners
  /** Glyphs in the element's subtree that share its space. */
  readonly glyphs: TargetGlyphs
  /** The element's own image record (an `<img>`, canvas, video or first
   * background image) as drawn by the mirror: its texel size, or null
   * when it has none or it isn't decoded yet. A Layer samples it with
   * `image: target`. */
  readonly image: TargetImage | null
  /** Changes whenever the target re-resolves (the scene was rebuilt). */
  readonly version: number
}

export interface TargetImage {
  width: number
  height: number
}

const ZERO_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 }
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]
const NO_RADIUS: Corners = [0, 0, 0, 0]
const NO_GLYPHS: TargetGlyphs = {
  count: 0,
  rects: new Float32Array(0),
  ids: new Uint32Array(0),
  text: []
}

/** The text runs whose glyphs make up a target's `glyphs`, in order. */
export function targetRuns(node: ElNode): GlyphRun[] {
  const runs: GlyphRun[] = []
  const space = node.space
  const visit = (n: ElNode): void => {
    for (const kid of n.kids) {
      if (kid.kind === 'element') {
        visit(kid)
      } else if (kid.kind === 'text' && (kid.space ?? 'doc') === space) {
        runs.push(kid)
      }
    }
  }
  visit(node)
  return runs
}

function collectGlyphs(node: ElNode): TargetGlyphs {
  const rects: number[] = []
  const ids: number[] = []
  const text: string[] = []
  for (const run of targetRuns(node)) {
    for (const g of run.glyphs) {
      rects.push(g.rect.x, g.rect.y, g.rect.width, g.rect.height)
      ids.push(g.glyphId)
      text.push(g.text)
    }
  }
  return {
    count: ids.length,
    rects: new Float32Array(rects),
    ids: new Uint32Array(ids),
    text
  }
}

/** A Target over `el`, re-resolving against `graph` on access. */
export function createTarget(el: Element, graph: RenderGraph | null): Target {
  let seen = -1
  let node: ElNode | undefined
  let glyphs: TargetGlyphs | null = null
  let version = 0
  const resolve = (): ElNode | undefined => {
    if (graph && graph.version !== seen) {
      seen = graph.version
      node = graph.nodeOf(el)
      glyphs = null
      version++
    }
    return node
  }
  const ownBox = (n: ElNode) => n.own.find((r) => r.kind === 'box' && !r.shadow)
  return {
    el,
    get found() {
      return resolve() !== undefined
    },
    get rect() {
      return resolve()?.rect ?? ZERO_RECT
    },
    get local() {
      const n = resolve()
      return (
        n?.place?.local ?? { w: n?.rect.width ?? 0, h: n?.rect.height ?? 0 }
      )
    },
    get xform() {
      const n = resolve()
      if (n?.place) {
        return n.place.xform
      }
      return n ? ([1, 0, 0, 1, n.rect.x, n.rect.y] as Affine) : IDENTITY
    },
    get space() {
      return resolve()?.space ?? 'doc'
    },
    get radius() {
      const n = resolve()
      const box = n ? ownBox(n) : undefined
      return box && box.kind === 'box' ? box.radius : NO_RADIUS
    },
    get glyphs() {
      const n = resolve()
      if (!n) {
        return NO_GLYPHS
      }
      glyphs ??= collectGlyphs(n)
      return glyphs
    },
    get image() {
      const r = graph?.imageOf(el)
      return r ? { width: r.width, height: r.height } : null
    },
    get version() {
      resolve()
      return version
    }
  }
}
