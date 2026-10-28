import type { SyncDiagnostics } from './dom/observer'
import type { TextReadStats } from './dom/read_pass'
import type { RenderGraph } from './gpu/graph'
import type { Profile } from './profile/profiler'
import type { Glyph } from './scene/records'

/** Identifies a registered font face for per-run resolution. */
export interface FontDescriptor {
  family?: string
  weight?: number
  italic?: boolean
}

export type Layer = 'boxes' | 'images' | 'text' | 'cutouts' | 'paths'
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
   * takes the faces in document.fonts the browser has loaded or is
   * loading, then each face it loads later (unused @font-face rules are
   * never fetched); an explicit list resolves just those, at start. Runs
   * whose family has no resolved face are drawn by the Canvas 2D fallback
   * atlas. */
  fonts?: 'auto' | FontFace[]
  /** URL of a baked-asset manifest (`compositor-gpu bake`, tools/bake.ts):
   * families it lists draw from the baked font files (fetched per family
   * as the page uses it) instead of parsing the @font-face sources, and a
   * page whose text is all baked never loads opentype.js. A weight or
   * optical size the manifest lacks falls back to the runtime path. Svg
   * files it lists draw as vectors from `<img data-gpu-vector>` (or
   * data-gpu-morph) whose src matches. */
  assets?: string
  /** What to do when WebGPU is unavailable. Default 'passthrough'. */
  fallback?: Fallback
  /** Override devicePixelRatio (default: window.devicePixelRatio). */
  devicePixelRatio?: number
  /** CSS px of canvas above and below the viewport (default: one viewport
   * height). The canvas scrolls with the document and is re-positioned
   * when the viewport leaves it; a larger margin means fewer re-anchors
   * and a larger canvas. */
  canvasMargin?: number
  /** 'page' (default): the canvas is part of the document and the browser
   * scrolls it with the page on its compositor thread, so content never
   * lags the scroll; anything drawn fixed to the viewport (a viewport-space
   * post pass, a hole for fixed chrome) trails it by a frame during fast
   * scrolls. 'viewport': the canvas is `position: fixed` and redrawn at
   * the new scroll position each frame, so viewport-anchored effects stay
   * locked and the whole page trails the scroll by up to a frame instead
   * (evenly in replace mode, where nothing else paints). `canvasMargin`
   * is ignored. */
  canvasPin?: 'page' | 'viewport'
  /** While a post pass runs over an unchanged scene (a trail or a lens
   * over a still page), run it on the previous frame's scene instead of
   * redrawing (`stats().sceneReused`). Default true; false always
   * redraws (for comparing). */
  sceneReuse?: boolean
  /** Render a parent's leaf opacity groups (nothing nested, no layer
   * transform, region, blur or drop shadow) into one shared texture in
   * one pass instead of a texture and pass each. Default true; false for
   * comparing. */
  groupAtlas?: boolean
  /** Keep an opacity group's texture between frames while nothing it
   * draws changed (its records, placement, filters), instead of
   * re-rendering it every frame the band is drawn (gpu/group_cache.ts).
   * Default true; false for comparing. */
  groupCache?: boolean
  /** After a partial read, replace the re-read records in place when the
   * edit kept their structure (same records, counts, clips; no stacking
   * context), instead of rebuilding the scene, and re-pack only changed
   * text. Default true; false always rebuilds (for comparing). */
  patchEdits?: boolean
  /** Patch partial reads that only change opacities (stacking contexts
   * matched one to one, their groups' alpha updated), and keep an element
   * that was below opacity 1 in the last second as a group at opacity 1,
   * so a fade never rebuilds the scene; the group goes with one re-read
   * when the hold ends. Default true; false for comparing. */
  patchOpacity?: boolean
  /** When a patched edit moves records (a word swap), keep the batch list
   * if no moved record now overlaps a record it draws on the wrong side
   * of (checked for the moved records only), and update their culling
   * bounds in place, instead of rebuilding both for the page. Default
   * true; false always rebuilds (for comparing). */
  refitBatches?: boolean
  /** Skip the instances of each draw that can't reach the canvas (records
   * more than half a canvas outside it): fewer vertices per frame on long
   * pages, at the cost of a few more draw calls (`stats().instances`).
   * With `canvasFill: 'band'` the region is the band instead. Default
   * true; false submits everything, 'canvas' culls to the canvas even
   * with a band (both for comparing). */
  cullDraws?: boolean | 'canvas'
  /** With `canvasPin: 'page'`: 'band' (default) redraws only the viewport
   * plus a band above and below sized to recent scroll steps (at least
   * 128 CSS px), keeping the rest of the canvas from earlier frames
   * (`stats().fillRows`): canvas the browser scrolls into view before the
   * next frame (a stalled main thread) shows what was last drawn there,
   * possibly stale. 'full' redraws the whole canvas, viewport and
   * margins, every frame. 'band-clear': the band, with the rest cleared
   * (canvas scrolled into view before the next frame is blank; for
   * comparing). Ignored with `canvasPin: 'viewport'`. */
  canvasFill?: 'full' | 'band' | 'band-clear'
  /** canvasFill 'band': the rows a re-anchor newly covers (about a
   * viewport) are cleared and drawn a strip per frame, nearest the
   * viewport first (at least 96 CSS px, twice the recent scroll step),
   * instead of all in the re-anchor frame. A stalled main thread soon
   * after a re-anchor can show the rows not yet drawn as blank. Default
   * true; false draws them at once (for comparing). */
  reanchorStrips?: boolean
  /** canvasFill 'band': draw only the band rows not drawn since the
   * content last changed, and skip a frame with nothing to draw (no
   * command buffer; the canvas keeps what it last presented), so a scroll
   * over a static page costs nothing but its re-anchors. Any change, and
   * content that draws differently every frame (viewport-space records,
   * active `/fx` layers, regions, layer transforms or materials,
   * backdrops), redraws the band as before. Default true; false redraws
   * the band every frame (for comparing). */
  skipUnchanged?: boolean
  /** ms to wait after start() for the mirror to be complete (see
   * `Compositor.ready`) before replace mode hides the page's paint anyway.
   * Default 1500. */
  handoffTimeout?: number
  /** ms over which an image fades in when its pixels arrive after the
   * canvas is shown (decoded `<img>` and background `url()` sources).
   * Default 0: drawn at once. Off while the viewer prefers reduced
   * motion. */
  imageFadeIn?: number
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
  /** Path records (shapes of vector-drawn inline svgs) in the scene. */
  paths: number
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
  /** Instances (records, glyphs) submitted in the most recent frame. */
  instances: number
  /** Device-px rows of the canvas the most recent frame drew (all of it
   * unless `canvasFill: 'band'`). */
  fillRows: number
  /** Device-px rows a re-anchor newly covered not yet drawn
   * (CompositorOptions.reanchorStrips). */
  pendingRows: number
  /** Frames skipped with nothing to draw since start
   * (CompositorOptions.skipUnchanged). */
  skippedFrames: number
  /** Opacity groups composited (offscreen + blended once) last frame. */
  groups: number
  /** Render passes those groups' textures took (CompositorOptions
   * .groupAtlas shares one among leaf groups). */
  groupPasses: number
  /** Groups drawn from their kept texture (CompositorOptions.groupCache)
   * and rendered afresh, last frame. */
  groupCacheHits: number
  groupCacheMisses: number
  /** The last frame ran the post chain on the previous frame's scene
   * instead of redrawing it (nothing feeding the scene had changed). */
  sceneReused: boolean
  /** Elements whose style/geometry the most recent DOM read visited. */
  readElements: number
  /** Running count of mutation-scoped (non-full) DOM reads. */
  partialReads: number
  /** Of those, the ones applied by replacing records in place rather
   * than rebuilding the scene (CompositorOptions.patchEdits). */
  patchedReads: number
  /** Of those, patches with moved records that kept the batch list
   * (CompositorOptions.refitBatches). */
  refits: number
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
  /** Part of `encodeMs` spent recomputing draw culling (0 when the last
   * frame reused it), ms. */
  cullMs: number
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
  /** Scene reuse (CompositorOptions.sceneReuse), switchable at runtime
   * for A/B comparisons (the HUD's R key). */
  sceneReuse: boolean
  /** The skeleton view: every pass draws its geometry as wireframe (each
   * instance's triangles, after material vertex hooks) instead of
   * shading it, coloured by part; groups, layer transforms and post
   * passes still apply (gpu/skeleton.ts). Default false. */
  skeleton: boolean
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
  /** Frame profiler: recordings (percentiles, dropped frames, hitch
   * causes), GPU pass timings and a live HUD. No-ops when inert. */
  readonly profile: Profile
  /** Resolves once the mirror is complete after the first start(): fonts
   * resolved, visible images uploaded, material pipelines compiled (or
   * `handoffTimeout` passed). In replace mode that is when the page's own
   * paint is hidden. Resolved at once when inert. */
  readonly ready: Promise<void>
}
