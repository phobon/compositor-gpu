import type { FrameContext } from '../types'
import { reportShaderErrors } from '../util/log'
import { FRAME_WGSL, type Shared } from './frame'

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
