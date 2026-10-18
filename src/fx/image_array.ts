import type { RenderGraph } from '../gpu/graph'
import type { ImageRegion } from '../images/image_renderer'
import { reportShaderErrors } from '../util/log'

// A layer's `images` binding: the image records of several elements, each
// copied into its own slice of a mipmapped texture array (`size` × `size`,
// stretched; the image's own size is kept for aspect fitting), so one
// layer draws many images with one texture. A slice is copied when its
// source's view or texels change (decode, atlas repack), in its own
// submit before the frame's render, from the regions of the last upload.

const BLIT_WGSL = /* wgsl */ `
struct Rect { uv : vec4f, lod : f32 };
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var smp : sampler;
@group(0) @binding(2) var<uniform> rect : Rect;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o : VOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  let t = mix(rect.uv.xy, rect.uv.zw, in.uv);
  return textureSampleLevel(src, smp, t, rect.lod);
}
`

/** Bytes per slice in the info buffer: (width, height, ready, 0). */
const INFO_STRIDE = 16

export class ImageArray {
  readonly texture: GPUTexture
  readonly view: GPUTextureView
  readonly sampler: GPUSampler
  /** Per slice: the source's texel size and 1 once copied. */
  readonly info: GPUBuffer
  private readonly levels: number
  private readonly pipeline: GPURenderPipeline
  /** Per slice: the source rect and lod for level 0. */
  private readonly rects: GPUBuffer[] = []
  /** The whole previous level, for the mip chain. */
  private readonly unit: GPUBuffer
  /** What each slice was copied from: view and uv. */
  private readonly from: (unknown[] | null)[]
  private readonly infoData: Float32Array

  constructor(
    private readonly device: GPUDevice,
    private readonly graph: RenderGraph,
    private readonly els: Element[],
    readonly size: number,
    label: string
  ) {
    const n = Math.max(1, els.length)
    this.levels = 1 + Math.floor(Math.log2(Math.max(1, size)))
    this.texture = device.createTexture({
      label: `${label}:images`,
      size: { width: size, height: size, depthOrArrayLayers: n },
      format: 'rgba8unorm',
      mipLevelCount: this.levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    })
    this.view = this.texture.createView({ dimension: '2d-array' })
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge'
    })
    this.info = device.createBuffer({
      label: `${label}:images-info`,
      size: n * INFO_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.infoData = new Float32Array(n * 4)
    this.from = els.map(() => null)
    const module = device.createShaderModule({
      label: `${label}:images-blit`,
      code: BLIT_WGSL
    })
    reportShaderErrors(module, `${label}:images-blit`)
    this.pipeline = device.createRenderPipeline({
      label: `${label}:images-blit`,
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{ format: 'rgba8unorm' }]
      },
      primitive: { topology: 'triangle-list' }
    })
    const rect = (): GPUBuffer =>
      device.createBuffer({
        label: `${label}:images-rect`,
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      })
    for (let i = 0; i < n; i++) {
      this.rects.push(rect())
    }
    this.unit = rect()
    device.queue.writeBuffer(this.unit, 0, new Float32Array([0, 0, 1, 1, 0]))
  }

  /** Copy the slices whose source changed. */
  update(): void {
    let enc: GPUCommandEncoder | null = null
    let infoChanged = false
    this.els.forEach((el, k) => {
      const r = this.graph.imageOf(el)
      const key = r ? [r.view, ...r.uv] : null
      const was = this.from[k]
      if (
        (key === null && was === null) ||
        (key && was && key.every((v, i) => v === was[i]))
      ) {
        return
      }
      this.from[k] = key
      this.infoData.set(r ? [r.width, r.height, 1, 0] : [0, 0, 0, 0], k * 4)
      infoChanged = true
      if (r) {
        enc ??= this.device.createCommandEncoder({ label: 'fx:images' })
        this.copy(enc, k, r)
      }
    })
    if (infoChanged) {
      this.device.queue.writeBuffer(this.info, 0, this.infoData)
    }
    if (enc) {
      this.device.queue.submit([(enc as GPUCommandEncoder).finish()])
    }
  }

  private copy(enc: GPUCommandEncoder, k: number, r: ImageRegion): void {
    const blit = (src: GPUTextureView, rect: GPUBuffer, level: number) => {
      const group = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: src },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: rect } }
        ]
      })
      const rp = enc.beginRenderPass({
        label: 'fx:images',
        colorAttachments: [
          {
            view: this.texture.createView({
              dimension: '2d',
              baseArrayLayer: k,
              arrayLayerCount: 1,
              baseMipLevel: level,
              mipLevelCount: 1
            }),
            loadOp: 'clear',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            storeOp: 'store'
          }
        ]
      })
      rp.setPipeline(this.pipeline)
      rp.setBindGroup(0, group)
      rp.draw(3)
      rp.end()
    }
    const rect = this.rects[k]
    if (!rect) {
      return
    }
    // Sample the source at the level nearest the slice's resolution.
    const scale = Math.max(r.width, r.height) / this.size
    const lod = Math.max(0, Math.log2(Math.max(scale, 1)))
    this.device.queue.writeBuffer(rect, 0, new Float32Array([...r.uv, lod]))
    blit(r.view, rect, 0)
    for (let l = 1; l < this.levels; l++) {
      const prev = this.texture.createView({
        dimension: '2d',
        baseArrayLayer: k,
        arrayLayerCount: 1,
        baseMipLevel: l - 1,
        mipLevelCount: 1
      })
      blit(prev, this.unit, l)
    }
  }

  destroy(): void {
    this.texture.destroy()
    this.info.destroy()
    for (const b of this.rects) {
      b.destroy()
    }
    this.unit.destroy()
  }
}
