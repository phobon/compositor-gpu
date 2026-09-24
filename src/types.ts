import type { Glyph } from './scene/records'

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
  /** Font discovery: 'auto' reads document.fonts, or pass explicit faces. */
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
  fps: number
}

export interface Compositor {
  start(): void
  stop(): void
  /** Force a re-read of the DOM + re-upload. */
  invalidate(): void
  destroy(): void
  /** True when a real GPU pipeline is active (false in passthrough). */
  readonly active: boolean
  /** Live counts + fps, for debug overlays. */
  stats(): CompositorStats
}
