import { FRAME_WGSL, type RenderPass, type Shared } from '../gpu/frame'
import type { ImageRecord } from '../scene/records'
import type { Scene } from '../scene/scene'
import { reportShaderErrors } from '../util/log'

const FLOATS_PER_IMAGE = 16 // rect(4) + uv(4) + params(4) + clip(4)
const BYTES_PER_IMAGE = FLOATS_PER_IMAGE * 4

const SHADER = /* wgsl */ `
${FRAME_WGSL}

struct Img {
  rect   : vec4f,   // x,y,w,h document space
  uv     : vec4f,   // u0,v0,u1,v1
  params : vec4f,   // opacity, _, _, _
  clip   : vec4f,   // minX, minY, maxX, maxY (doc space)
};
@group(1) @binding(0) var<storage, read> imgs : array<Img>;
@group(1) @binding(1) var tex  : texture_2d<f32>;
@group(1) @binding(2) var samp : sampler;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
  @location(1) @interpolate(flat) idx : u32,
  @location(2) docp : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32,
      @builtin(instance_index) ii : u32) -> VOut {
  var quad = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let im = imgs[ii];
  let corner = quad[vi];
  let p = im.rect.xy + corner * im.rect.zw;
  var out : VOut;
  out.pos = doc_to_clip(p);
  out.uv = mix(im.uv.xy, im.uv.zw, corner);
  out.idx = ii;
  out.docp = p;
  return out;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  let im = imgs[in.idx];
  let cl = im.clip;
  if (in.docp.x < cl.x || in.docp.y < cl.y ||
      in.docp.x > cl.z || in.docp.y > cl.w) { discard; }
  let c = textureSample(tex, samp, in.uv);
  let o = im.params.x;
  return vec4f(c.rgb * c.a * o, c.a * o); // premultiplied
}
`

interface Cached {
  view: GPUTextureView
  texture: GPUTexture
  src: string
  w: number
  h: number
}

/**
 * Textured-quad pass for <img>. One texture per source (cached), one instance
 * per on-screen image; object-fit maps to the quad rect (contain) and/or UV
 * sub-rect (cover). Distinct textures mean one draw per image (draw(6,1,0,i)),
 * each with its own bind group over the shared instance buffer.
 */
export class ImagePass implements RenderPass {
  readonly layer = 'images' as const
  private pipeline: GPURenderPipeline
  private group1Layout: GPUBindGroupLayout
  private sampler: GPUSampler
  private buffer: GPUBuffer | null = null
  private capacity = 0
  private data = new Float32Array(0)
  private cache = new WeakMap<CanvasImageSource, Cached>()
  /** Aligned with scene.images: null where the texture isn't ready yet. */
  private draws: (GPUBindGroup | null)[] = []

  constructor(private readonly shared: Shared) {
    const { device, format, frameLayout } = shared
    this.group1Layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' }
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} }
      ]
    })
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge'
    })
    const module = device.createShaderModule({ code: SHADER })
    reportShaderErrors(module, 'image')
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [frameLayout, this.group1Layout]
      }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
            }
          }
        ]
      },
      primitive: { topology: 'triangle-list' }
    })
  }

  private ensureCapacity(n: number): void {
    if (n <= this.capacity && this.buffer) return
    const cap = Math.max(n, this.capacity ? this.capacity * 2 : 16)
    this.buffer?.destroy()
    this.buffer = this.shared.device.createBuffer({
      size: cap * BYTES_PER_IMAGE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.data = new Float32Array(cap * FLOATS_PER_IMAGE)
    this.capacity = cap
  }

  private textureFor(rec: ImageRecord): Cached | null {
    const src = rec.source
    const [w, h] = naturalSize(src)
    if (w === 0 || h === 0) return null
    const key = srcKey(src)
    const { device } = this.shared
    const cached = this.cache.get(src)
    if (cached && cached.src === key && cached.w === w && cached.h === h) {
      // Dynamic sources (<video>, <canvas>) change every frame — re-copy pixels.
      if (rec.dynamic) {
        device.queue.copyExternalImageToTexture(
          { source: src as GPUCopyExternalImageSource },
          { texture: cached.texture },
          [w, h]
        )
      }
      return cached
    }
    cached?.texture.destroy()

    const texture = device.createTexture({
      size: [w, h],
      format: 'rgba8unorm-srgb',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT
    })
    device.queue.copyExternalImageToTexture(
      { source: src as GPUCopyExternalImageSource },
      { texture },
      [w, h]
    )
    const entry: Cached = {
      view: texture.createView(),
      texture,
      src: key,
      w,
      h
    }
    this.cache.set(src, entry)
    return entry
  }

  upload(scene: Scene): void {
    const images = scene.images
    this.draws = []
    if (images.length === 0) return
    this.ensureCapacity(images.length)
    const d = this.data
    for (let i = 0; i < images.length; i++) {
      const rec = images[i]
      const o = i * FLOATS_PER_IMAGE
      const cached = rec ? this.textureFor(rec) : null
      if (!rec || !cached) {
        // Keep the instance index aligned with scene.images: zero-size quad,
        // no bind group, so draw() skips it without shifting later indices.
        d.fill(0, o, o + FLOATS_PER_IMAGE)
        this.draws.push(null)
        continue
      }
      const [nw, nh] = naturalSize(rec.source)
      const { rect, uv } = fit(rec, nw, nh)
      d[o + 0] = rect.x
      d[o + 1] = rect.y
      d[o + 2] = rect.w
      d[o + 3] = rect.h
      d[o + 4] = uv.u0
      d[o + 5] = uv.v0
      d[o + 6] = uv.u1
      d[o + 7] = uv.v1
      d[o + 8] = rec.opacity
      d[o + 9] = 0
      d[o + 10] = 0
      d[o + 11] = 0
      const c = rec.clip
      d[o + 12] = c ? c.x : -1e9
      d[o + 13] = c ? c.y : -1e9
      d[o + 14] = c ? c.x + c.width : 1e9
      d[o + 15] = c ? c.y + c.height : 1e9
      this.draws.push(
        this.shared.device.createBindGroup({
          layout: this.group1Layout,
          entries: [
            { binding: 0, resource: { buffer: this.buffer as GPUBuffer } },
            { binding: 1, resource: cached.view },
            { binding: 2, resource: this.sampler }
          ]
        })
      )
    }
    this.shared.device.queue.writeBuffer(
      this.buffer as GPUBuffer,
      0,
      d,
      0,
      images.length * FLOATS_PER_IMAGE
    )
  }

  draw(encoder: GPURenderPassEncoder, first: number, count: number): void {
    if (this.draws.length === 0) return
    encoder.setPipeline(this.pipeline)
    const end = first + count
    for (let i = first; i < end; i++) {
      const bg = this.draws[i]
      if (!bg) continue
      encoder.setBindGroup(1, bg)
      encoder.draw(6, 1, 0, i)
    }
  }

  destroy(): void {
    this.buffer?.destroy()
  }
}

function naturalSize(src: CanvasImageSource): [number, number] {
  const s = src as Partial<
    HTMLImageElement & HTMLVideoElement & { width: number; height: number }
  >
  const w = s.naturalWidth ?? s.videoWidth ?? s.width ?? 0
  const h = s.naturalHeight ?? s.videoHeight ?? s.height ?? 0
  return [w as number, h as number]
}

function srcKey(src: CanvasImageSource): string {
  const s = src as Partial<HTMLImageElement>
  return s.currentSrc ?? s.src ?? '<canvas>'
}

interface Fit {
  rect: { x: number; y: number; w: number; h: number }
  uv: { u0: number; v0: number; u1: number; v1: number }
}

/** Map object-fit to a quad rect (contain letterbox) and/or UV crop (cover). */
function fit(rec: ImageRecord, natW: number, natH: number): Fit {
  const { x, y, width: w, height: h } = rec.rect
  const full = { u0: 0, v0: 0, u1: 1, v1: 1 }
  const box = { x, y, w, h }
  if (natW === 0 || natH === 0 || rec.objectFit === 'fill') {
    return { rect: box, uv: full }
  }
  const boxAspect = w / h
  const imgAspect = natW / natH
  if (rec.objectFit === 'cover') {
    if (imgAspect > boxAspect) {
      const frac = boxAspect / imgAspect
      const u0 = (1 - frac) / 2
      return { rect: box, uv: { u0, v0: 0, u1: 1 - u0, v1: 1 } }
    }
    const frac = imgAspect / boxAspect
    const v0 = (1 - frac) / 2
    return { rect: box, uv: { u0: 0, v0, u1: 1, v1: 1 - v0 } }
  }
  // contain: fit inside, letterbox by shrinking the quad
  if (imgAspect > boxAspect) {
    const dh = w / imgAspect
    return { rect: { x, y: y + (h - dh) / 2, w, h: dh }, uv: full }
  }
  const dw = h * imgAspect
  return { rect: { x: x + (w - dw) / 2, y, w: dw, h }, uv: full }
}
