import type { ElNode } from '../dom/tree'
import type { ImageRegion } from '../images/imageRenderer'
import type { GlyphTable } from '../text/slug/rasterizer'
import type { FrameContext } from '../types'
import { reportShaderErrors } from '../util/log'
import { FRAME_WGSL, type Shared } from './frame'
import type { MaterialBinding } from './material'

// The render-graph hook (docs/EFFECTS.md, core extension points 1 and 4):
// what the effects layer (`compositor-gpu/fx`) plugs into. With no post
// chain, or one whose active() is false, Renderer.render() draws straight
// to the swapchain as before. Otherwise the scene renders into an
// offscreen texture the size of the canvas, the chain records its stages,
// and the canvas pass copies the scene through and lets the chain's last
// stage overwrite `rect` (the visible viewport plus the chain's radius).

/** A rect in canvas device px. */
export interface DeviceRect {
  x: number
  y: number
  width: number
  height: number
}

/** What the post chain gets each frame it runs. */
export interface PostFrame {
  encoder: GPUCommandEncoder
  /** The scene, rendered offscreen at the canvas's device size. */
  scene: GPUTextureView
  sceneWidth: number
  sceneHeight: number
  /** The visible viewport within the canvas, device px (snapped to whole
   * pixels and clamped to the canvas). */
  viewport: DeviceRect
  /** `viewport` grown by the chain's radius() (× dpr), clamped: the region
   * the chain writes. Outside it the canvas shows the scene unchanged. */
  rect: DeviceRect
  ctx: FrameContext
  dpr: number
}

/** A post-processing chain run between the scene and the canvas. */
export interface PostChain {
  /** False: the renderer takes the direct path this frame. */
  active(): boolean
  /** Largest sampling radius of the active stages, CSS px. */
  radius(): number
  /** Record every stage except the last, into the chain's own targets. */
  encode(frame: PostFrame): void
  /** Draw the last stage into the canvas pass `rp` (bind group 0 is the
   * shared Frame; the scissor is `frame.rect`). Must write without
   * blending: the scene copy is already under it. */
  composite(rp: GPURenderPassEncoder, frame: PostFrame): void
}

/** Where an extra layer draws in paint order (RenderGraph.addLayer). */
export type LayerPlace = 'above' | 'below' | { after: Element }

/** Geometry drawn in the scene's paint order (an `/fx` Layer). */
export interface ExtraLayer {
  place: LayerPlace
  /** Draw into the current target (the canvas, the post scene texture or
   * a group texture); bind group 0 is that target's Frame, so `to_clip`
   * places doc and viewport positions. */
  draw(rp: GPURenderPassEncoder, ctx: FrameContext): void
  /** False: skipped this frame. */
  active(): boolean
}

/** What a region handler gets when its isolated group closes. */
export interface RegionFrame {
  encoder: GPUCommandEncoder
  /** The group texture: the element's subtree at full opacity. */
  source: GPUTextureView
  /** Its allocated size, device px (>= the used region). */
  sourceWidth: number
  sourceHeight: number
  /** The used region in the parent target's device px (also the group
   * texture's texel (0, 0) and size). */
  x: number
  y: number
  width: number
  height: number
  /** The parent target: doc-space origin and device px per CSS px. */
  parentX: number
  parentY: number
  scale: number
  /** The group's opacity (the element's own, 1 when it has none). */
  alpha: number
  ctx: FrameContext
  dpr: number
}

/** Composites one isolated element (a region `/fx` Pass). */
export interface RegionHandler {
  /** CSS px to grow the group texture by on every side (the effect's
   * reach past the element). */
  pad(): number
  /** False: composite the group plainly this frame. */
  active(): boolean
  /** Record any intermediate stages, before the parent pass resumes. */
  encode(frame: RegionFrame): void
  /** Draw into the parent target's pass (premultiplied over; the
   * renderer resets the scissor afterwards). */
  composite(rp: GPURenderPassEncoder, frame: RegionFrame): void
}

/**
 * A layer transform: how an isolated element's group is composited, read
 * every frame (mutate it, then requestFrame). CSS order: translate, then
 * rotate, then scale, about the origin. The DOM is untouched, so hit
 * testing stays at the element's layout position.
 */
export interface LayerTransform {
  /** CSS px. */
  x: number
  y: number
  scaleX: number
  scaleY: number
  /** Degrees, clockwise. */
  rotate: number
  /** Multiplies the element's own opacity. */
  opacity: number
  /** Fractions of the element's border box. */
  originX: number
  originY: number
}

/** A Material registered with the graph (an `/fx` Material). */
export interface MaterialEntry extends MaterialBinding {
  /** The element whose subtree's records it re-shades. */
  readonly target: Element
  /** False: the records draw with the default pipeline this frame. */
  active(): boolean
  /** Glyphs numbered by the last batch build (mat_index's range). */
  glyphs?: number
}

/** Per-frame participant registered through RenderGraph.addHook. */
export interface FrameHook {
  /** After the DOM reads and re-anchoring, before onGlyph/onFrame and
   * render. May fill `ctx.pointer`. */
  beforeFrame?(ctx: FrameContext): void
  /** True keeps the rAF loop running after this frame. */
  keepAlive?(): boolean
}

/** The compositor's extension surface for the effects layer. */
export interface RenderGraph {
  readonly shared: Shared
  /** Install (or clear, with null) the post chain. Requests a frame. */
  setPostChain(chain: PostChain | null): void
  /** Register a frame hook; returns its removal function. */
  addHook(hook: FrameHook): () => void
  /** Schedule a frame (coalesced; a no-op while the compositor is
   * stopped). */
  requestFrame(): void
  /** Draw `layer` at its place in paint order; returns its removal. */
  addLayer(layer: ExtraLayer): () => void
  /** Re-resolve extra-layer places now (a Layer's `place` changed). */
  replace(): void
  /** Render `el`'s subtree as one group composited by `handler` (null
   * ends it). Takes effect on the next read, which this schedules. */
  isolate(el: Element, handler: RegionHandler | null): void
  /** Composite `el`'s subtree as one group through `t` (null ends it).
   * Starting or ending takes effect on the next read, which this
   * schedules; later changes to `t` only need requestFrame. A region
   * handler on the same element takes precedence. */
  transform(el: Element, t: LayerTransform | null): void
  /** Re-shade `entry.target`'s subtree (records of `entry.kinds`) with
   * the material; returns its removal. On overlap the later wins. Call
   * replace() after `active()` changes. */
  addMaterial(entry: MaterialEntry): () => void
  /** A material id unique for this compositor (for MaterialEntry.id). */
  nextMaterialId(): number
  /** Material pipelines still compiling (test harnesses wait on 0). */
  materialsPending(): number
  /** Hide (or restore) `el`'s own paint in the DOM, as replace mode does
   * per element; the mirror is unaffected. */
  hideSource(el: Element, hidden: boolean): void
  /** The mirror's node for `el` from the most recent read. */
  nodeOf(el: Element): ElNode | undefined
  /** Where the pixels of `el`'s own image record (an `<img>`, canvas,
   * video or its first background image) are on the GPU as of the last
   * upload; null when it has none or it isn't decoded yet. Call while
   * encoding (an ExtraLayer's draw): an atlas grow replaces the view. */
  imageOf(el: Element): ImageRegion | null
  /** The Slug glyph buffers as of the last text upload (null with no
   * text layer or no Slug glyphs). Call while encoding, as imageOf. */
  glyphTable(): GlyphTable | null
  /** Bumped whenever the scene is rebuilt (records and z change). */
  readonly version: number
}

const COPY_WGSL = /* wgsl */ `
${FRAME_WGSL}
@group(1) @binding(0) var src : texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  return textureLoad(src, vec2i(pos.xy), 0);
}
`

/** Copies a same-size texture onto the current pass texel for texel (a
 * fullscreen triangle, no blending). */
export class CopyThrough {
  private readonly pipeline: GPURenderPipeline
  private readonly layout: GPUBindGroupLayout
  private bindGroup: GPUBindGroup | null = null
  private view: GPUTextureView | null = null

  constructor(private readonly shared: Shared) {
    const { device, format, frameLayout } = shared
    this.layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' }
        }
      ]
    })
    const module = device.createShaderModule({
      label: 'copy-through',
      code: COPY_WGSL
    })
    reportShaderErrors(module, 'copy-through')
    this.pipeline = device.createRenderPipeline({
      label: 'copy-through',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [frameLayout, this.layout]
      }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }
    })
  }

  draw(rp: GPURenderPassEncoder, view: GPUTextureView): void {
    if (view !== this.view || !this.bindGroup) {
      this.view = view
      this.bindGroup = this.shared.device.createBindGroup({
        layout: this.layout,
        entries: [{ binding: 0, resource: view }]
      })
    }
    rp.setPipeline(this.pipeline)
    rp.setBindGroup(1, this.bindGroup)
    rp.draw(3)
  }

  /** Drop the cached bind group (its texture is going away). */
  release(): void {
    this.bindGroup = null
    this.view = null
  }
}
