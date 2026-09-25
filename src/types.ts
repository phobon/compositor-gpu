import type { Glyph } from './scene/records'

/** Identifies a registered font face for per-run resolution. */
export interface FontDescriptor {
  family?: string
  weight?: number
  italic?: boolean
}

export type Layer = 'boxes' | 'images' | 'text'
export type Mode = 'overlay' | 'replace'
export type Fallback = 'passthrough' | 'throw'

export interface FrameContext {
  /** ms since page load (performance.now). */
  time: number
  /** seconds since previous frame. */
  dt: number
  scrollX: number
  scrollY: number
  /** CSS px size of the mirrored viewport. */
  width: number
  height: number
}

export interface CompositorOptions {
  /** Subtree to mirror. Defaults to document.body. */
  root?: HTMLElement
  /** 'overlay' paints over the page; 'replace' hides DOM paint, keeps a11y. */
  mode?: Mode
  /** Which layers to render. Defaults to all three. */
  layers?: Layer[]
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
  /** Glyphs drawn via the Canvas 2D fallback atlas in the last text upload. */
  fallback: number
  /** Ligature glyphs formed (GSUB liga/clig) in the last text upload. */
  ligatures: number
  /** Slug faces registered (static + variable sources). */
  faces: number
  /** Layers re-uploaded in the most recent frame (0..3). */
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
  /** Wall time of the last DOM read (full or partial), ms. */
  readMs: number
  /** Wall time spent in pass uploads in the most recent render, ms. */
  uploadMs: number
  /** Wall time from createCommandEncoder to submit, ms. */
  encodeMs: number
  fps: number
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
  /** The overlay canvas; null in passthrough/inert. */
  readonly canvas: HTMLCanvasElement | null
  /** Live counts + fps, for debug overlays. */
  stats(): CompositorStats
}
