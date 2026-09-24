import { FRAME_WGSL, type RenderPass, type Shared } from '../gpu/frame'
import type { ImageRecord } from '../scene/records'
import type { Scene } from '../scene/scene'
import { reportShaderErrors } from '../util/log'

// rect(4) + uv(4) + params(4) + clip(4) + radius(4) + tile(4) + erect(4)
const FLOATS_PER_IMAGE = 28
const BYTES_PER_IMAGE = FLOATS_PER_IMAGE * 4

/** params.y bit 0: tile (fit 'none') repeats instead of clamping. */
const FLAG_REPEAT = 1
/** params.y bit 1: sample via `tile` (fit 'none') instead of the
 * vertex-interpolated `uv` (fill/cover/contain). */
const FLAG_UV_FROM_TILE = 2

const SHADER = /* wgsl */ `
${FRAME_WGSL}

struct Img {
  rect   : vec4f,   // x,y,w,h document space (quad rect)
  uv     : vec4f,   // u0,v0,u1,v1 — used unless FLAG_UV_FROM_TILE is set
  params : vec4f,   // opacity, flags, _, _
  clip   : vec4f,   // minX, minY, maxX, maxY (doc space)
  radius : vec4f,   // tl, tr, br, bl (px) — clips against erect
  tile   : vec4f,   // originX, originY, w, h (doc space) — fit 'none' only
  erect  : vec4f,   // element's own border-box rect (doc space)
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

// Signed distance to a rounded box with per-corner radius.
fn sd_round_box(p : vec2f, b : vec2f, r4 : vec4f) -> f32 {
  let top = select(r4.x, r4.y, p.x > 0.0);      // tl / tr
  let bot = select(r4.w, r4.z, p.x > 0.0);      // bl / br
  let r = select(top, bot, p.y > 0.0);
  let q = abs(p) - b + vec2f(r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - r;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  let im = imgs[in.idx];
  let cl = im.clip;
  if (in.docp.x < cl.x || in.docp.y < cl.y ||
      in.docp.x > cl.z || in.docp.y > cl.w) { discard; }

  let flags = u32(im.params.y);
  var uv = in.uv;
  if ((flags & ${FLAG_UV_FROM_TILE}u) != 0u) {
    uv = (in.docp - im.tile.xy) / im.tile.zw;
    if ((flags & ${FLAG_REPEAT}u) != 0u) {
      uv = fract(uv);
    } else if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      discard;
    }
  }

  // Rounded clip against the owning element's border box, not the quad —
  // 'contain' can shrink the quad inside it, but the radius still applies
  // to the element.
  let ec = im.erect.xy + im.erect.zw * 0.5;
  let half = im.erect.zw * 0.5;
  let d = sd_round_box(in.docp - ec, half, im.radius);
  let aa = max(fwidth(d), 1e-4);
  let cov = 1.0 - smoothstep(-aa, aa, d);

  let c = textureSample(tex, samp, uv);
  let o = im.params.x * cov;
  return vec4f(c.rgb * c.a * o, c.a * o); // premultiplied
}
`

const BLIT_SHADER = /* wgsl */ `
struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};

@vertex
fn vs_blit(@builtin(vertex_index) vi : u32) -> VOut {
  // Fullscreen triangle: NDC positions that overshoot the viewport, with UV
  // derived from the same positions (flipping y: NDC is y-up, textures are
  // y-down).
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out : VOut;
  let p = pos[vi];
  out.pos = vec4f(p, 0.0, 1.0);
  out.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return out;
}

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var srcSamp : sampler;

@fragment
fn fs_blit(in : VOut) -> @location(0) vec4f {
  return textureSample(srcTex, srcSamp, in.uv);
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
 * Textured-quad pass for <img> and (via `dom/backgrounds.ts`)
 * `background-image` url layers. One texture per source (cached), one
 * instance per on-screen image; object-fit/position maps to the quad rect
 * and/or UV sub-rect, and the element's border radius clips the fragment.
 * Distinct textures mean one draw per image (draw(6,1,0,i)), each with its
 * own bind group over the shared instance buffer.
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

  // Lazily-built mip-generation pipeline, shared across every non-dynamic
  // texture (they're all the same fixed format).
  private blitPipeline: GPURenderPipeline | null = null
  private blitLayout: GPUBindGroupLayout | null = null
  private blitSampler: GPUSampler | null = null

  constructor(private readonly shared: Shared) {
    const { device, frameLayout } = shared
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
      mipmapFilter: 'linear',
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
            format: shared.format,
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

  private ensureBlitPipeline(): void {
    if (this.blitPipeline) return
    const { device } = this.shared
    this.blitLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }
      ]
    })
    const module = device.createShaderModule({ code: BLIT_SHADER })
    reportShaderErrors(module, 'image-blit')
    this.blitPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.blitLayout]
      }),
      vertex: { module, entryPoint: 'vs_blit' },
      fragment: {
        module,
        entryPoint: 'fs_blit',
        targets: [{ format: 'rgba8unorm-srgb' }]
      },
      primitive: { topology: 'triangle-list' }
    })
    this.blitSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear'
    })
  }

  /** Downsample level 0 into every level of `texture`, one render pass
   * each, via a fullscreen-triangle blit. */
  private generateMips(texture: GPUTexture, mipLevelCount: number): void {
    this.ensureBlitPipeline()
    const pipeline = this.blitPipeline as GPURenderPipeline
    const layout = this.blitLayout as GPUBindGroupLayout
    const sampler = this.blitSampler as GPUSampler
    const { device } = this.shared
    const encoder = device.createCommandEncoder()
    for (let level = 1; level < mipLevelCount; level++) {
      const srcView = texture.createView({
        baseMipLevel: level - 1,
        mipLevelCount: 1
      })
      const dstView = texture.createView({
        baseMipLevel: level,
        mipLevelCount: 1
      })
      const bindGroup = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: sampler }
        ]
      })
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: dstView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 }
          }
        ]
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3)
      pass.end()
    }
    device.queue.submit([encoder.finish()])
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

    // Dynamic sources re-copy every frame, so a mip chain would just be
    // stale most of the time; only static sources get one.
    const mipLevelCount = rec.dynamic
      ? 1
      : 1 + Math.floor(Math.log2(Math.max(w, h)))
    const texture = device.createTexture({
      size: [w, h],
      format: 'rgba8unorm-srgb',
      mipLevelCount,
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
    if (mipLevelCount > 1) this.generateMips(texture, mipLevelCount)
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
      const f = fit(rec, nw, nh)
      d[o + 0] = f.rect.x
      d[o + 1] = f.rect.y
      d[o + 2] = f.rect.w
      d[o + 3] = f.rect.h
      d[o + 4] = f.uv.u0
      d[o + 5] = f.uv.v0
      d[o + 6] = f.uv.u1
      d[o + 7] = f.uv.v1
      d[o + 8] = rec.opacity
      d[o + 9] = f.flags
      d[o + 10] = 0
      d[o + 11] = 0
      const c = rec.clip
      d[o + 12] = c ? c.x : -1e9
      d[o + 13] = c ? c.y : -1e9
      d[o + 14] = c ? c.x + c.width : 1e9
      d[o + 15] = c ? c.y + c.height : 1e9
      d[o + 16] = rec.radius[0]
      d[o + 17] = rec.radius[1]
      d[o + 18] = rec.radius[2]
      d[o + 19] = rec.radius[3]
      d[o + 20] = f.tile.x
      d[o + 21] = f.tile.y
      d[o + 22] = f.tile.w
      d[o + 23] = f.tile.h
      d[o + 24] = rec.rect.x
      d[o + 25] = rec.rect.y
      d[o + 26] = rec.rect.width
      d[o + 27] = rec.rect.height
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
  /** Tile origin + size (doc space); only meaningful for fit 'none'. */
  tile: { x: number; y: number; w: number; h: number }
  flags: number
}

const FULL_UV = { u0: 0, v0: 0, u1: 1, v1: 1 }
const NO_TILE = { x: 0, y: 0, w: 0, h: 0 }

/**
 * Map object-fit/object-position (or the equivalent background-size /
 * background-position) to a quad rect and either a UV sub-rect (fill,
 * cover, contain — all sample the vertex-interpolated UV) or a tile rect
 * the fragment shader maps doc-space fragment position into (fit 'none':
 * the natural-size image placed by `position`, optionally repeated).
 */
function fit(rec: ImageRecord, natW: number, natH: number): Fit {
  const { x, y, width: w, height: h } = rec.rect
  const box = { x, y, w, h }
  const [px, py] = rec.position

  if (natW === 0 || natH === 0) {
    return { rect: box, uv: FULL_UV, tile: NO_TILE, flags: 0 }
  }

  if (rec.objectFit === 'none') {
    const tile = {
      x: x + (w - natW) * px,
      y: y + (h - natH) * py,
      w: natW,
      h: natH
    }
    const flags = FLAG_UV_FROM_TILE | (rec.repeat ? FLAG_REPEAT : 0)
    return { rect: box, uv: FULL_UV, tile, flags }
  }

  if (rec.objectFit === 'fill') {
    return { rect: box, uv: FULL_UV, tile: NO_TILE, flags: 0 }
  }

  const boxAspect = w / h
  const imgAspect = natW / natH
  if (rec.objectFit === 'cover') {
    if (imgAspect > boxAspect) {
      const frac = boxAspect / imgAspect
      const u0 = (1 - frac) * px
      return {
        rect: box,
        uv: { u0, v0: 0, u1: u0 + frac, v1: 1 },
        tile: NO_TILE,
        flags: 0
      }
    }
    const frac = imgAspect / boxAspect
    const v0 = (1 - frac) * py
    return {
      rect: box,
      uv: { u0: 0, v0, u1: 1, v1: v0 + frac },
      tile: NO_TILE,
      flags: 0
    }
  }

  // contain: fit inside, letterbox by shrinking the quad, offset by position
  if (imgAspect > boxAspect) {
    const dh = w / imgAspect
    return {
      rect: { x, y: y + (h - dh) * py, w, h: dh },
      uv: FULL_UV,
      tile: NO_TILE,
      flags: 0
    }
  }
  const dw = h * imgAspect
  return {
    rect: { x: x + (w - dw) * px, y, w: dw, h },
    uv: FULL_UV,
    tile: NO_TILE,
    flags: 0
  }
}
