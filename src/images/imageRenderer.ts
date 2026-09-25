import { FRAME_WGSL, type RenderPass, type Shared } from '../gpu/frame'
import { MipGenerator, mipLevelCountFor } from '../gpu/mips'
import type { ImageRecord } from '../scene/records'
import type { Scene } from '../scene/scene'
import { reportShaderErrors } from '../util/log'
import { ImageAtlas, MAX_ENTRY_SIZE } from './imageAtlas'

// rect(4) + uv(4) + params(4) + clip(4) + radius(4) + tile(4) + xf0(4) +
// xf1(4) + atlas(4)
const FLOATS_PER_IMAGE = 36
const BYTES_PER_IMAGE = FLOATS_PER_IMAGE * 4

/** params.y bit 0: tile (fit 'none') repeats instead of clamping. */
const FLAG_REPEAT = 1
/** params.y bit 1: sample via `tile` (fit 'none') instead of the
 * vertex-interpolated `uv` (fill/cover/contain). */
const FLAG_UV_FROM_TILE = 2
/** params.y bit 2: the instance is packed into the shared atlas — remap the
 * fragment's [0,1] uv into `atlas.xy..atlas.zw` (clamped half a texel in,
 * per `params.zw`, to avoid bleeding into the entry's gutter). */
const FLAG_ATLAS = 4
/** params.y bit 3: viewport-space record (position: fixed) — its
 * positions and clip exclude the scroll offset (see frame.ts to_clip). */
const FLAG_VIEWPORT = 8

const SHADER = /* wgsl */ `
${FRAME_WGSL}

// Local space: the record's untransformed box, origin at its top-left.
struct Img {
  rect   : vec4f,   // x,y,w,h local space (quad rect)
  uv     : vec4f,   // u0,v0,u1,v1 — used unless FLAG_UV_FROM_TILE is set
  params : vec4f,   // opacity, flags, atlas half-texel inset u/v
  clip   : vec4f,   // minX, minY, maxX, maxY (the record's space)
  radius : vec4f,   // tl, tr, br, bl (px) — clips against the local box
  tile   : vec4f,   // originX, originY, w, h (local space) — fit 'none' only
  xf0    : vec4f,   // a, b, c, d: linear part of local -> doc
  xf1    : vec4f,   // tx, ty (doc space), local box w, h
  atlas  : vec4f,   // u0,v0,u1,v1 of the entry in atlas uv space (FLAG_ATLAS)
};
@group(1) @binding(0) var<storage, read> imgs : array<Img>;
@group(1) @binding(1) var tex  : texture_2d<f32>;
@group(1) @binding(2) var samp : sampler;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
  @location(1) @interpolate(flat) idx : u32,
  @location(2) docp : vec2f,
  @location(3) lp : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32,
      @builtin(instance_index) ii : u32) -> VOut {
  var quad = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let im = imgs[ii];
  let corner = quad[vi];
  let lp = im.rect.xy + corner * im.rect.zw;
  let m = im.xf0;
  let p = vec2f(m.x * lp.x + m.z * lp.y, m.y * lp.x + m.w * lp.y) + im.xf1.xy;
  var out : VOut;
  let space = select(0.0, 1.0, (u32(im.params.y) & ${FLAG_VIEWPORT}u) != 0u);
  out.pos = to_clip(p, space);
  out.uv = mix(im.uv.xy, im.uv.zw, corner);
  out.idx = ii;
  out.docp = p;
  out.lp = lp;
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
    uv = (in.lp - im.tile.xy) / im.tile.zw;
    if ((flags & ${FLAG_REPEAT}u) != 0u) {
      uv = fract(uv);
    } else if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      discard;
    }
  }
  if ((flags & ${FLAG_ATLAS}u) != 0u) {
    let inset = im.params.zw;
    let cu = clamp(uv, inset, vec2f(1.0) - inset);
    uv = mix(im.atlas.xy, im.atlas.zw, cu);
  }

  // Rounded clip against the record's local box, not the quad — 'contain'
  // can shrink the quad inside it, but the radius still applies to the
  // element. Local space, so it rotates/scales with the element.
  let half = im.xf1.zw * 0.5;
  let d = sd_round_box(in.lp - half, half, im.radius);
  let aa = max(fwidth(d), 1e-4);
  let cov = 1.0 - smoothstep(-aa, aa, d);

  let c = textureSample(tex, samp, uv);
  let o = im.params.x * cov;
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
 * Textured-quad pass for <img> and (via `dom/backgrounds.ts`)
 * `background-image` url layers. Small static sources are packed into a
 * shared `ImageAtlas`, so a run of on-screen atlas instances draws in one
 * `draw(6,n,0,i0)`; anything ineligible (dynamic, or bigger than
 * `MAX_ENTRY_SIZE`) falls back to its own cached texture and bind group,
 * one draw per image as before. object-fit/position maps to the quad rect
 * and/or UV sub-rect, and the element's border radius clips the fragment.
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
  /** Aligned with scene.images: null (not ready), 'atlas' (shared bind
   * group), or a standalone per-instance bind group. */
  private draws: (GPUBindGroup | null | 'atlas')[] = []

  private readonly atlas: ImageAtlas
  private atlasBindGroup: GPUBindGroup | null = null
  private atlasBindGroupGen = -1
  private atlasBindGroupBuffer: GPUBuffer | null = null

  // Lazily-built mip-generation pipeline, shared across every non-dynamic
  // texture (standalone or atlas — they're all the same fixed format).
  private readonly mips: MipGenerator

  constructor(private readonly shared: Shared) {
    this.atlas = new ImageAtlas(shared.device)
    this.mips = new MipGenerator(shared.device)
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
    if (n <= this.capacity && this.buffer) {
      return
    }
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
    if (w === 0 || h === 0) {
      return null
    }
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
    const mipLevelCount = rec.dynamic ? 1 : mipLevelCountFor(Math.max(w, h))
    const texture = device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
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
    if (mipLevelCount > 1) {
      this.mips.generate(texture, mipLevelCount)
    }
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
    if (images.length === 0) {
      return
    }
    this.ensureCapacity(images.length)
    const d = this.data
    for (let i = 0; i < images.length; i++) {
      const rec = images[i]
      const o = i * FLOATS_PER_IMAGE
      if (!rec) {
        // Keep the instance index aligned with scene.images: zero-size quad,
        // no bind group, so draw() skips it without shifting later indices.
        d.fill(0, o, o + FLOATS_PER_IMAGE)
        this.draws.push(null)
        continue
      }
      const [nw, nh] = naturalSize(rec.source)
      if (nw === 0 || nh === 0) {
        d.fill(0, o, o + FLOATS_PER_IMAGE)
        this.draws.push(null)
        continue
      }
      // Static <img>/background sources up to MAX_ENTRY_SIZE try the shared
      // atlas first, so a texture is never allocated for them; anything
      // else (dynamic, oversized, or an atlas that's full) falls back to
      // its own cached texture and bind group.
      const atlasEligible =
        !rec.dynamic &&
        rec.source instanceof HTMLImageElement &&
        Math.max(nw, nh) <= MAX_ENTRY_SIZE
      const spot = atlasEligible
        ? this.atlas.add(rec.source as HTMLImageElement, nw, nh)
        : null
      const cached = spot ? null : this.textureFor(rec)
      if (!spot && !cached) {
        d.fill(0, o, o + FLOATS_PER_IMAGE)
        this.draws.push(null)
        continue
      }
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
      const vflag = rec.space === 'viewport' ? FLAG_VIEWPORT : 0
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
      const xf = rec.xform
      d[o + 24] = xf[0]
      d[o + 25] = xf[1]
      d[o + 26] = xf[2]
      d[o + 27] = xf[3]
      d[o + 28] = xf[4]
      d[o + 29] = xf[5]
      d[o + 30] = rec.local.w
      d[o + 31] = rec.local.h

      if (spot) {
        const s = this.atlas.size
        d[o + 9] = f.flags | FLAG_ATLAS | vflag
        d[o + 10] = 0.5 / spot.w
        d[o + 11] = 0.5 / spot.h
        d[o + 32] = spot.x / s
        d[o + 33] = spot.y / s
        d[o + 34] = (spot.x + spot.w) / s
        d[o + 35] = (spot.y + spot.h) / s
        this.draws.push('atlas')
        continue
      }
      d[o + 9] = f.flags | vflag
      d[o + 10] = 0
      d[o + 11] = 0
      d[o + 32] = 0
      d[o + 33] = 0
      d[o + 34] = 0
      d[o + 35] = 0
      this.draws.push(
        this.shared.device.createBindGroup({
          layout: this.group1Layout,
          entries: [
            { binding: 0, resource: { buffer: this.buffer as GPUBuffer } },
            // Reached only when `cached` was resolved above (spot is null
            // here, and the combined null case already `continue`d).
            { binding: 1, resource: (cached as Cached).view },
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
    this.atlas.flush()
  }

  private ensureAtlasBindGroup(): GPUBindGroup {
    if (
      this.atlasBindGroup &&
      this.atlasBindGroupGen === this.atlas.generation &&
      this.atlasBindGroupBuffer === this.buffer
    ) {
      return this.atlasBindGroup
    }
    this.atlasBindGroup = this.shared.device.createBindGroup({
      layout: this.group1Layout,
      entries: [
        { binding: 0, resource: { buffer: this.buffer as GPUBuffer } },
        { binding: 1, resource: this.atlas.view as GPUTextureView },
        { binding: 2, resource: this.sampler }
      ]
    })
    this.atlasBindGroupGen = this.atlas.generation
    this.atlasBindGroupBuffer = this.buffer
    return this.atlasBindGroup
  }

  /** Consecutive atlas-backed instances collapse into one draw call;
   * standalone ones (and gaps) draw individually / are skipped. Returns the
   * number of draw calls issued. */
  draw(encoder: GPURenderPassEncoder, first: number, count: number): number {
    if (this.draws.length === 0) {
      return 0
    }
    encoder.setPipeline(this.pipeline)
    const end = first + count
    let issued = 0
    let i = first
    while (i < end) {
      const bg = this.draws[i]
      if (bg === null) {
        i++
        continue
      }
      if (bg === 'atlas') {
        let j = i + 1
        while (j < end && this.draws[j] === 'atlas') {
          j++
        }
        encoder.setBindGroup(1, this.ensureAtlasBindGroup())
        encoder.draw(6, j - i, 0, i)
        issued++
        i = j
        continue
      }
      encoder.setBindGroup(1, bg)
      encoder.draw(6, 1, 0, i)
      issued++
      i++
    }
    return issued
  }

  destroy(): void {
    this.buffer?.destroy()
    this.atlas.destroy()
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
  /** Tile origin + size (local space); only meaningful for fit 'none'. */
  tile: { x: number; y: number; w: number; h: number }
  flags: number
}

const FULL_UV = { u0: 0, v0: 0, u1: 1, v1: 1 }
const NO_TILE = { x: 0, y: 0, w: 0, h: 0 }

/**
 * Map object-fit/object-position (or the equivalent background-size /
 * background-position) to a quad rect and either a UV sub-rect (fill,
 * cover, contain — all sample the vertex-interpolated UV) or a tile rect
 * the fragment shader maps the local fragment position into (fit 'none':
 * the natural-size image placed by `position`, optionally repeated). All
 * rects are in the record's local space (origin at its local box's
 * top-left, see ImageRecord.xform).
 */
function fit(rec: ImageRecord, natW: number, natH: number): Fit {
  const x = 0
  const y = 0
  const w = rec.local.w
  const h = rec.local.h
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
