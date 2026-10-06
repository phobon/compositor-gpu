import type { SyncDiagnostics } from './dom/observer'
import type { TextReadStats } from './dom/textRuns'
import type { RenderGraph } from './gpu/graph'
import type { Glyph } from './scene/records'

/** Identifies a registered font face for per-run resolution. */
export interface FontDescriptor {
  family?: string
  weight?: number
  italic?: boolean
}

export type Layer = 'boxes' | 'images' | 'text' | 'cutouts'
export type Mode = 'overlay' | 'replace'
export type Fallback = 'passthrough' | 'throw'

export interface FrameContext {
  /** ms since page load (performance.now). */
  time: number
  /** seconds since previous frame. */
  dt: number
  /** Real document scroll offset (CSS px). */
  scrollX: number
  scrollY: number
  /** CSS px size of the mirrored viewport. */
  width: number
  height: number
  /** Document-space origin of the canvas (its anchor), CSS px. The canvas
   * scrolls with the document and covers the viewport plus a margin. */
  canvasX: number
  canvasY: number
  /** CSS px size of the canvas. */
  canvasWidth: number
  canvasHeight: number
  /** Pointer state, filled in by the effects layer (`compositor-gpu/fx`)
   * when it is installed; null otherwise. */
  pointer: PointerState | null
}

/** One recorded click: page (document) CSS px and the page clock, s. */
export interface PointerClick {
  x: number
  y: number
  t: number
}

/** Pointer state as tracked by `compositor-gpu/fx` (src/fx/pointer.ts). */
export interface PointerState {
  /** Raw position, viewport CSS px. */
  x: number
  y: number
  /** Raw position, page (document) CSS px. */
  pageX: number
  pageY: number
  /** Raw velocity, CSS px/s, smoothed over the last few frames. */
  vx: number
  vy: number
  down: boolean
  /** False until the first pointer event. */
  seen: boolean
  /** Eased follower: viewport CSS px and CSS px/s. */
  follow: { x: number; y: number; vx: number; vy: number }
  /** Follower ease per 60 Hz frame (0..1, default 0.12). Writable. */
  ease: number
  /** The last 8 clicks, most recent first. */
  clicks: PointerClick[]
}

export interface CompositorOptions {
  /** Subtree to mirror. Defaults to document.body. */
  root?: HTMLElement
  /** 'overlay' paints over the page; 'replace' hides DOM paint, keeps a11y. */
  mode?: Mode
  /** Which layers to render. Defaults to all. 'cutouts' (the holes left
   * by `data-gpu-ignore` elements) is added whenever any other layer is,
   * unless `cutouts` is false. */
  layers?: Layer[]
  /** False: no holes for `data-gpu-ignore` elements (they are skipped,
   * and mirrored content under them paints over them). Default true. */
  cutouts?: boolean
  /** In 'replace' mode, hide the source's own painting (keeps hit-testing). */
  hideSource?: boolean
  /** Faces whose bytes the Slug text backend fetches: 'auto' (default)
   * reads document.fonts; an explicit list resolves just those. Runs whose
   * family has no resolved face are drawn by the Canvas 2D fallback atlas. */
  fonts?: 'auto' | FontFace[]
  /** What to do when WebGPU is unavailable. Default 'passthrough'. */
  fallback?: Fallback
  /** Override devicePixelRatio (default: window.devicePixelRatio). */
  devicePixelRatio?: number
  /** CSS px of canvas above and below the viewport (default: one viewport
   * height). The canvas scrolls with the document and is re-positioned
   * when the viewport leaves it; a larger margin means fewer re-anchors
   * and a larger canvas. */
  canvasMargin?: number
  /** z-index of the canvas (default: 2147483646, above everything). Site
   * chrome that is `position: fixed` and `data-gpu-ignore`d is better put
   * ABOVE the canvas than shown through a hole: the canvas scrolls with
   * the document, so a hole for a fixed element trails it by a frame while
   * scrolling. Pass a value below that chrome's z-index (in the root
   * stacking context) and it paints over the canvas with no hole needed. */
  zIndex?: number
  /** Verbose logging. */
  debug?: boolean
  /** Per-glyph hook, called each frame before draw. Mutate glyph.offset here. */
  onGlyph?: (glyph: Glyph, ctx: FrameContext) => void
  /** Per-frame hook, called after the scene is current, before draw. */
  onFrame?: (ctx: FrameContext) => void
}

export interface CompositorStats {
  active: boolean
  boxes: number
  images: number
  glyphs: number
  /** Cutout records (`data-gpu-ignore` holes) in the scene. */
  cutouts: number
  /** Glyphs drawn via the Canvas 2D fallback atlas in the last text upload. */
  fallback: number
  /** Up to 12 distinct fallback graphemes: `"text" family weight reason`
   * (`no-face`: the family has no Slug face; `no-glyph`: the face lacks
   * the code point, it's a multi-code-point cluster, or it's over the curve
   * budget). */
  fallbackSamples: string[]
  /** Ligature glyphs formed (GSUB liga/clig) in the last text upload. */
  ligatures: number
  /** Slug faces registered (static + variable sources). */
  faces: number
  /** Layers re-uploaded in the most recent frame (0..4). */
  uploads: number
  /** Draw batches issued in the most recent frame. */
  batches: number
  /** `encoder.draw` calls issued in the most recent frame — lower than
   * `batches` when a pass collapses several instances into one draw (e.g.
   * atlas-backed images). */
  draws: number
  /** Opacity groups composited (offscreen + blended once) last frame. */
  groups: number
  /** Elements whose style/geometry the most recent DOM read visited. */
  readElements: number
  /** Running count of mutation-scoped (non-full) DOM reads. */
  partialReads: number
  /** Why the mirror was invalidated (cumulative counts per dirty flag),
   * how many elements are tracked as animating, and the last mutation's
   * target. `readMs` rising while `mutation`/`animating` tick at idle
   * means something on the page invalidates the mirror every frame; put
   * `data-gpu-ignore` on it if it isn't meant to be mirrored. */
  sync: SyncDiagnostics
  /** The last DOM read's text geometry: glyphs, how many of them took a
   * Range of their own instead of a canvas-split chunk (`FAST_TEXT_READ`),
   * and Range layout queries issued. */
  textRead: TextReadStats
  /** Wall time of the last DOM read (full or partial), ms. */
  readMs: number
  /** Wall time spent in pass uploads in the most recent render, ms. */
  uploadMs: number
  /** Wall time from createCommandEncoder to submit, ms. */
  encodeMs: number
  fps: number
  /** Wall time of the last frame callback (read + hooks + encode), ms. */
  frameMs: number
  /** Longest gap between two frames in the last second, ms (a hitch shows
   * here even when `fps` averages fine). */
  maxDtMs: number
  /** True while inside the settle window after the last scroll event. */
  scrolling: boolean
  /** Document-space position of the canvas's top-left corner, CSS px. */
  anchorX: number
  anchorY: number
  /** Running count of canvas re-positions (the viewport left the canvas,
   * or a resize). */
  reanchors: number
}

export interface Compositor {
  start(): void
  stop(): void
  /** Force a re-read of the DOM + re-upload. */
  invalidate(): void
  /** Hide or show the mirrored root's own paint (replace mode), reversibly. */
  setSourceHidden(hidden: boolean): void
  destroy(): void
  /** True when a real GPU pipeline is active (false in passthrough). */
  readonly active: boolean
  /** The mirror canvas (absolutely positioned in the document); null in
   * passthrough/inert. */
  readonly canvas: HTMLCanvasElement | null
  /** Live counts + fps, for debug overlays. */
  stats(): CompositorStats
  /** Extension surface for `compositor-gpu/fx` (gpu/graph.ts); null when
   * inert. */
  readonly graph: RenderGraph | null
}
