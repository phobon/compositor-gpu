import { FRAME_WGSL, type RenderPass, type Shared } from '../gpu/frame'
import {
  MAT_DEFAULT_WGSL,
  MAT_GRID_WGSL,
  MAT_IN_WGSL,
  type MaterialBinding,
  MaterialPipelines,
  PREMUL_BLEND
} from '../gpu/material'
import { MipGenerator, mipLevelCountFor } from '../gpu/mips'
import { copyExternalImage } from '../gpu/upload'
import type { ImageRecord } from '../scene/records'
import type { Scene } from '../scene/scene'
import { log, reportShaderErrors } from '../util/log'
import {
  type AtlasRect,
  type AtlasSource,
  ImageAtlas,
  MAX_ENTRY_SIZE
} from './imageAtlas'
import {
  concreteSize,
  type SvgIntrinsic,
  sizedMarkup,
  svgIntrinsic
} from './svgRaster'

/** Rasterised-SVG canvases stay bounded: past this many entries the whole
 * cache is dropped rather than evicted one at a time (`ImagePass.svgCache`). */
const SVG_CACHE_LIMIT = 64
/** Rasterised SVG canvases are clamped to this on a side — well above any
 * on-screen display size, floor against a degenerate 0px layout box. */
const SVG_RASTER_MAX = 2048
const SVG_RASTER_MIN = 1

/**
 * True for an `<img>` source whose current URL is an SVG: a `data:image/svg`
 * URI, or a path ending in `.svg` (case-insensitive, query/hash ignored).
 * Browsers rasterise these at their *natural* size (which for an inline SVG
 * with explicit `width`/`height` can be arbitrarily large, e.g.
 * gatsby-plugin-image's 2560x2560 transparent sizer) — the image pass
 * re-rasterises them itself at display size instead of trusting that.
 */
export function isSvgSource(src: string): boolean {
  const s = src.toLowerCase()
  if (s.startsWith('data:image/svg')) {
    return true
  }
  const cut = Math.min(
    s.indexOf('?') === -1 ? s.length : s.indexOf('?'),
    s.indexOf('#') === -1 ? s.length : s.indexOf('#')
  )
  return s.slice(0, cut).endsWith('.svg')
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

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

/** The image shader with material hooks `mat` (gpu/material.ts) on a
 * `subdiv` × `subdiv` quad; the default variant has identity hooks. */
const shader = (
  mat: string,
  subdiv: number,
  wrap: string
): string => /* wgsl */ `
${FRAME_WGSL}
${MAT_IN_WGSL}
${MAT_GRID_WGSL}
${mat}
const MAT_SUBDIV : u32 = ${subdiv}u;

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
  let im = imgs[ii];
  let corner = mat_corner(vi, MAT_SUBDIV);
  let lp0 = im.rect.xy + corner * im.rect.zw;
  let lp = mat_vertex(lp0, im.xf1.zw, lp0 / max(im.xf1.zw, vec2f(1e-4)), ii);
  let m = im.xf0;
  let p = vec2f(m.x * lp.x + m.z * lp.y, m.y * lp.x + m.w * lp.y) + im.xf1.xy;
  var out : VOut;
  let space = select(0.0, 1.0, (u32(im.params.y) & ${FLAG_VIEWPORT}u) != 0u);
  out.pos = to_clip(p, space);
  out.uv = mix(im.uv.xy, im.uv.zw, corner);
  out.idx = ii;
  out.docp = p;
  out.lp = lp0;
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

// Set by base_fs for material hooks (mat_sample): the fragment's source
// uv before the atlas mapping, its derivatives and the record.
var<private> mat_uv : vec2f;
var<private> mat_ddx : vec2f;
var<private> mat_ddy : vec2f;
var<private> mat_rec : u32;

fn base_fs(in : VOut) -> vec4f {
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
  mat_uv = uv;
  mat_ddx = dpdx(uv);
  mat_ddy = dpdy(uv);
  mat_rec = in.idx;
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

${wrap}
`

const DEFAULT_FS = /* wgsl */ `
@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  return base_fs(in);
}
`

const MATERIAL_FS = /* wgsl */ `
// The source image \`delta\` CSS px away from this fragment (in the
// image's local axes), premultiplied, without the rounded clip.
fn mat_sample(delta : vec2f) -> vec4f {
  let im = imgs[mat_rec];
  let flags = u32(im.params.y);
  var per = (im.uv.zw - im.uv.xy) / max(im.rect.zw, vec2f(1e-4));
  if ((flags & ${FLAG_UV_FROM_TILE}u) != 0u) {
    per = 1.0 / max(im.tile.zw, vec2f(1e-4));
  }
  var uv = mat_uv + delta * per;
  if ((flags & ${FLAG_REPEAT}u) != 0u) {
    uv = fract(uv);
  }
  uv = clamp(uv, vec2f(0.0), vec2f(1.0));
  var gx = mat_ddx;
  var gy = mat_ddy;
  if ((flags & ${FLAG_ATLAS}u) != 0u) {
    let inset = im.params.zw;
    uv = mix(im.atlas.xy, im.atlas.zw, clamp(uv, inset, vec2f(1.0) - inset));
    // The derivatives were taken before the atlas mapping.
    let span = im.atlas.zw - im.atlas.xy;
    gx = gx * span;
    gy = gy * span;
  }
  let c = textureSampleGrad(tex, samp, uv, gx, gy);
  return vec4f(c.rgb * c.a, c.a);
}

@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  let c = base_fs(in);
  let im = imgs[in.idx];
  let size = im.xf1.zw;
  let half = size * 0.5;
  let d = sd_round_box(in.lp - half, half, im.radius);
  let aa = max(fwidth(d), 1e-4);
  let cov = (1.0 - smoothstep(-aa, aa, d)) * im.params.x;
  return mat_fragment(MatIn(c, in.lp, size,
    in.lp / max(size, vec2f(1e-4)), in.docp, cov, d, in.idx, 1u));
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
 *
 * A plain `<img>` is never uploaded straight from the element: for a
 * responsive `srcset`/`sizes` image, `naturalWidth`/`naturalHeight` are
 * density-corrected (e.g. 1366w shown at 1280 CSS px) while the decoded
 * bitmap is the raw 1366², so copying `[naturalWidth, naturalHeight]` from
 * the element crops its top-left corner instead of scaling it down.
 * `createImageBitmap(img)` decodes the real pixel size (its own
 * `.width`/`.height`, uncorrected), so the copy is done from the bitmap
 * instead, once per source key (`bitmapCache`/`pendingBitmaps`). Until that
 * resolves the record draws nothing (a zero instance, index alignment
 * preserved); `onReady` re-triggers a frame once it does. SVG-rasterised
 * canvases and canvas/video sources are already decoded at their true size
 * and skip this.
 */
export class ImagePass implements RenderPass {
  readonly layer = 'images' as const
  private pipeline: GPURenderPipeline
  private readonly materials: MaterialPipelines
  private group1Layout: GPUBindGroupLayout
  private sampler: GPUSampler
  private buffer: GPUBuffer | null = null
  private capacity = 0
  private data = new Float32Array(0)
  private cache = new WeakMap<CanvasImageSource, Cached>()
  /** Rasterised-SVG canvases, keyed by `currentSrc@WxH` so a resize (a new
   * display size) re-rasterises rather than stretching a stale one. Bounded:
   * cleared wholesale past `SVG_CACHE_LIMIT` entries. */
  private svgCache = new Map<
    string,
    {
      source: OffscreenCanvas | HTMLCanvasElement
      w: number
      h: number
      /** False while an async (re-sized markup) decode is pending. */
      ready: boolean
    }
  >()
  /** Aligned with scene.images: null (not ready), 'atlas' (shared bind
   * group), or a standalone per-instance bind group. */
  private draws: (GPUBindGroup | null | 'atlas')[] = []

  /** Source keys with a `createImageBitmap()` in flight — fetched once. */
  private pendingBitmaps = new Set<string>()
  /** Source keys whose `createImageBitmap()` rejected (tainted/cross-origin)
   * — logged once, never retried. */
  private failedBitmaps = new Set<string>()

  private readonly atlas: ImageAtlas
  private atlasBindGroup: GPUBindGroup | null = null
  private atlasBindGroupGen = -1
  private atlasBindGroupBuffer: GPUBuffer | null = null

  // Lazily-built mip-generation pipeline, shared across every non-dynamic
  // texture (standalone or atlas — they're all the same fixed format).
  private readonly mips: MipGenerator

  constructor(
    private readonly shared: Shared,
    private readonly onReady: () => void
  ) {
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
    const describe = (
      code: string,
      label: string,
      extra: GPUBindGroupLayout | null
    ): GPURenderPipelineDescriptor => {
      const module = device.createShaderModule({ label, code })
      reportShaderErrors(module, label)
      const layouts = [frameLayout, this.group1Layout]
      if (extra) {
        layouts.push(extra)
      }
      return {
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [{ format: shared.format, blend: PREMUL_BLEND }]
        },
        primitive: { topology: 'triangle-list' }
      }
    }
    this.pipeline = device.createRenderPipeline(
      describe(shader(MAT_DEFAULT_WGSL, 1, DEFAULT_FS), 'image', null)
    )
    this.materials = new MaterialPipelines(
      'image',
      device,
      (code, n, label, layout) =>
        describe(shader(code, n, MATERIAL_FS), label, layout)
    )
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

  /** `source`/`w`/`h` are already resolved (an SVG source has already been
   * rasterised to a canvas at display size by the caller); `key` identifies
   * it for cache invalidation — the caller's explicit key for a rasterised
   * canvas, or `srcKey(source)` for a plain `<img>`/`<video>`/`<canvas>`. */
  private textureFor(
    source: CanvasImageSource,
    w: number,
    h: number,
    dynamic: boolean,
    key: string
  ): Cached | null {
    if (w === 0 || h === 0) {
      return null
    }
    const { device } = this.shared
    const cached = this.cache.get(source)
    if (cached && cached.src === key && cached.w === w && cached.h === h) {
      // Dynamic sources (<video>, <canvas>) change every frame — re-copy pixels.
      if (dynamic) {
        copyExternalImage(
          device,
          { source: source as GPUCopyExternalImageSource },
          { texture: cached.texture },
          [w, h]
        )
      }
      return cached
    }
    cached?.texture.destroy()

    // Dynamic sources re-copy every frame, so a mip chain would just be
    // stale most of the time; only static sources get one.
    const mipLevelCount = dynamic ? 1 : mipLevelCountFor(Math.max(w, h))
    const texture = device.createTexture({
      label: `image ${dynamic ? 'dynamic' : 'static'} ${key.slice(0, 80)}`,
      size: [w, h],
      format: 'rgba8unorm',
      mipLevelCount,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT
    })
    copyExternalImage(
      device,
      { source: source as GPUCopyExternalImageSource },
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
    this.cache.set(source, entry)
    return entry
  }

  /** Kick off `createImageBitmap(img)` for `key` if it isn't already pending
   * or known to fail — deduped by source key, so a source seen again before
   * the first fetch resolves is a no-op. On resolve, packs/uploads the
   * bitmap's *own* pixel size (never `img.naturalWidth/Height`, which can be
   * density-corrected relative to the decoded bitmap) into the atlas or a
   * standalone texture, closes the bitmap, and calls `onReady` so a pending
   * frame re-uploads this record with real data. On reject (tainted/CORS
   * source), logs once and never retries. */
  private requestBitmap(img: HTMLImageElement, key: string): void {
    if (this.pendingBitmaps.has(key) || this.failedBitmaps.has(key)) {
      return
    }
    this.pendingBitmaps.add(key)
    createImageBitmap(img)
      .then((bitmap) => {
        this.pendingBitmaps.delete(key)
        const w = bitmap.width
        const h = bitmap.height
        if (w > 0 && h > 0) {
          const spot =
            Math.max(w, h) <= MAX_ENTRY_SIZE
              ? this.atlas.add(bitmap, w, h, key, img)
              : null
          // Oversized, or the atlas is full (`add` already logs that once) —
          // same fallback the generic non-bitmap path takes.
          if (!spot) {
            this.cacheBitmapTexture(img, bitmap, w, h, key)
          }
        }
        bitmap.close()
        this.onReady()
      })
      .catch((err) => {
        this.pendingBitmaps.delete(key)
        this.failedBitmaps.add(key)
        log.warn(`ImagePass: createImageBitmap failed for ${key}`, err)
      })
  }

  /** Upload a resolved `ImageBitmap` into a standalone `w`x`h` texture,
   * cached under `img` the same way `textureFor` caches a live element —
   * `img` is never dynamic here (SVG/canvas/video never reach this path),
   * so there is no per-frame re-copy once cached. */
  private cacheBitmapTexture(
    img: HTMLImageElement,
    bitmap: ImageBitmap,
    w: number,
    h: number,
    key: string
  ): void {
    const { device } = this.shared
    this.cache.get(img)?.texture.destroy()
    const mipLevelCount = mipLevelCountFor(Math.max(w, h))
    const texture = device.createTexture({
      label: `image bitmap ${key.slice(0, 80)}`,
      size: [w, h],
      format: 'rgba8unorm',
      mipLevelCount,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT
    })
    copyExternalImage(device, { source: bitmap }, { texture }, [w, h])
    if (mipLevelCount > 1) {
      this.mips.generate(texture, mipLevelCount)
    }
    this.cache.set(img, { view: texture.createView(), texture, src: key, w, h })
  }

  /** Rasterise an SVG `<img>` at `w`x`h` device px (its concrete object
   * size; see svgRaster.ts) instead of uploading it at its natural size —
   * the natural size of an SVG with explicit `width`/`height` can be
   * arbitrarily large (a transparent sizer, a diagram meant to be shown
   * tiny) and costs a full rasterisation + upload for pixels nothing ever
   * samples. A parsed (`data:`) SVG is re-serialised at that size and
   * decoded asynchronously, so its own preserveAspectRatio places the
   * content as the browser's does; null until then (onReady re-triggers a
   * frame). Others are drawn from the element, scaled. Cached by
   * `currentSrc@WxH`, so a resize rasterises again. */
  private rasterizeSvg(
    img: HTMLImageElement,
    w: number,
    h: number,
    intr: SvgIntrinsic
  ): {
    source: OffscreenCanvas | HTMLCanvasElement
    w: number
    h: number
  } | null {
    const key = `${srcKey(img)}@${w}x${h}`
    const hit = this.svgCache.get(key)
    if (hit) {
      return hit.ready ? hit : null
    }
    if (this.svgCache.size > SVG_CACHE_LIMIT) {
      this.svgCache.clear()
    }
    let canvas: OffscreenCanvas | HTMLCanvasElement
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(w, h)
    } else {
      const el = document.createElement('canvas')
      el.width = w
      el.height = h
      canvas = el
    }
    const ctx = (canvas as HTMLCanvasElement).getContext('2d', {
      willReadFrequently: true
    }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
    if (!ctx) {
      return null
    }
    const markup = sizedMarkup(intr, w, h)
    const entry = { source: canvas, w, h, ready: markup === null }
    this.svgCache.set(key, entry)
    if (markup === null) {
      ctx.drawImage(img, 0, 0, w, h)
      return entry
    }
    const sized = new Image()
    sized.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
    sized
      .decode()
      .then(() => {
        ctx.drawImage(sized, 0, 0, w, h)
      })
      .catch(() => {
        // Unparseable at this size: fall back to the scaled element.
        ctx.drawImage(img, 0, 0, w, h)
      })
      .finally(() => {
        if (this.svgCache.get(key) === entry) {
          entry.ready = true
          this.onReady()
        }
      })
    return null
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
      // An SVG <img> is rasterised at DISPLAY size (device px, clamped),
      // never at its natural size — that can be arbitrarily large (a
      // transparent sizer at 2560x2560, a diagram meant to be shown tiny)
      // and rasterising + uploading it at full size stalls the main thread
      // for nothing ever sampled. The rasterised canvas stands in as the
      // upload source for the rest of this record; its size stands in as
      // the "natural" size fit() and the atlas key use.
      let uploadSource: CanvasImageSource = rec.source
      let nw: number
      let nh: number
      // The size fit() places by (CSS px for 'none'); the texture size
      // otherwise. Differs for SVG sources, rasterised at device px.
      let fitW: number | null = null
      let fitH: number | null = null
      let atlasKey: string | undefined
      let spot: AtlasRect | null = null
      let cached: Cached | null = null
      if (
        rec.source instanceof HTMLImageElement &&
        isSvgSource(srcKey(rec.source))
      ) {
        // Rasterised at its CSS concrete object size (object-fit / the
        // background-size mapping against the intrinsic ratio), as the
        // browser renders it — see svgRaster.ts.
        const dpr = this.shared.dpr || 1
        const area = areaOf(rec)
        const src = srcKey(rec.source)
        const intr = svgIntrinsic(rec.source, src)
        const size = concreteSize(rec.objectFit, area.w, area.h, intr)
        const w = clamp(Math.ceil(size.w * dpr), SVG_RASTER_MIN, SVG_RASTER_MAX)
        const h = clamp(Math.ceil(size.h * dpr), SVG_RASTER_MIN, SVG_RASTER_MAX)
        fitW = size.w
        fitH = size.h
        const raster = this.rasterizeSvg(rec.source, w, h, intr)
        if (!raster) {
          d.fill(0, o, o + FLOATS_PER_IMAGE)
          this.draws.push(null)
          continue
        }
        uploadSource = raster.source
        nw = raster.w
        nh = raster.h
        atlasKey = `${srcKey(rec.source)}@${w}x${h}`
      } else if (rec.source instanceof HTMLImageElement) {
        // Plain (non-SVG) <img>: naturalWidth/Height can be density-
        // corrected relative to the decoded bitmap (a responsive srcset
        // picked a denser candidate than 1 CSS px == 1 device px), so the
        // real pixel size — and the texture/atlas entry itself — only exist
        // once `createImageBitmap(img)` has resolved (see `requestBitmap`).
        // Until then this record draws nothing; index alignment is kept.
        const img = rec.source
        const key = srcKey(img)
        if (this.failedBitmaps.has(key)) {
          d.fill(0, o, o + FLOATS_PER_IMAGE)
          this.draws.push(null)
          continue
        }
        const atlasRect = this.atlas.get(key)
        const texCached = this.cache.get(img)
        if (atlasRect) {
          spot = atlasRect
          nw = atlasRect.w
          nh = atlasRect.h
        } else if (texCached && texCached.src === key) {
          cached = texCached
          nw = texCached.w
          nh = texCached.h
        } else {
          this.requestBitmap(img, key)
          d.fill(0, o, o + FLOATS_PER_IMAGE)
          this.draws.push(null)
          continue
        }
      } else {
        ;[nw, nh] = naturalSize(rec.source)
      }
      if (nw === 0 || nh === 0) {
        d.fill(0, o, o + FLOATS_PER_IMAGE)
        this.draws.push(null)
        continue
      }
      // Static background sources (rasterised SVG canvases) up to
      // MAX_ENTRY_SIZE try the shared atlas first, so a texture is never
      // allocated for them; anything else (dynamic, oversized, or an atlas
      // that's full) falls back to its own cached texture and bind group.
      // A plain <img> already has `spot`/`cached` from its bitmap cache
      // above and skips this — its atlas/texture upload happened once, off
      // the bitmap, when it resolved.
      if (!spot && !cached) {
        const atlasEligible =
          !rec.dynamic &&
          atlasKey !== undefined &&
          Math.max(nw, nh) <= MAX_ENTRY_SIZE
        spot = atlasEligible
          ? this.atlas.add(uploadSource as AtlasSource, nw, nh, atlasKey)
          : null
        cached = spot
          ? null
          : this.textureFor(
              uploadSource,
              nw,
              nh,
              rec.dynamic ?? false,
              atlasKey ?? srcKey(rec.source)
            )
      }
      if (!spot && !cached) {
        d.fill(0, o, o + FLOATS_PER_IMAGE)
        this.draws.push(null)
        continue
      }
      const dst = snapRecord(rec, this.shared.dpr > 0 ? this.shared.dpr : 1)
      const f = fit(dst, fitW ?? nw, fitH ?? nh)
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
      const xf = dst.xform
      d[o + 24] = xf[0]
      d[o + 25] = xf[1]
      d[o + 26] = xf[2]
      d[o + 27] = xf[3]
      d[o + 28] = xf[4]
      d[o + 29] = xf[5]
      d[o + 30] = dst.local.w
      d[o + 31] = dst.local.h

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
  draw(
    encoder: GPURenderPassEncoder,
    first: number,
    count: number,
    material?: MaterialBinding | null
  ): number {
    if (this.draws.length === 0) {
      return 0
    }
    const mp = this.materials.get(material)
    encoder.setPipeline(mp ?? this.pipeline)
    let verts = 6
    if (mp && material) {
      encoder.setBindGroup(2, material.bindGroup)
      const n = Math.max(1, Math.floor(material.subdivisions))
      verts = 6 * n * n
    }
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
        encoder.draw(verts, j - i, 0, i)
        issued++
        i = j
        continue
      }
      encoder.setBindGroup(1, bg)
      encoder.draw(verts, 1, 0, i)
      issued++
      i++
    }
    return issued
  }

  dropMaterial(id: number): void {
    this.materials.drop(id)
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

/** The positioning area (background-origin) in the record's local space. */
function areaOf(rec: ImageRecord): {
  x: number
  y: number
  w: number
  h: number
} {
  const [t, r, b, l] = rec.originInset ?? [0, 0, 0, 0]
  return { x: l, y: t, w: rec.local.w - l - r, h: rec.local.h - t - b }
}

/**
 * Snap an untransformed record's destination rect to device pixels, as the
 * box pass does (edges rounded, size kept at 1 device px at least, origin
 * insets floored like border widths). Sampling follows the snapped rect
 * because `fit()` runs on the result. Transformed records pass through.
 */
function snapRecord(rec: ImageRecord, dpr: number): ImageRecord {
  const xf = rec.xform
  if (xf[0] !== 1 || xf[1] !== 0 || xf[2] !== 0 || xf[3] !== 1) {
    return rec
  }
  const snap = (v: number) => Math.round(v * dpr) / dpr
  const min = (v: number) => (v > 0 ? 1 / dpr : 0)
  const x0 = snap(xf[4])
  const y0 = snap(xf[5])
  const w = Math.max(snap(xf[4] + rec.local.w) - x0, min(rec.local.w))
  const h = Math.max(snap(xf[5] + rec.local.h) - y0, min(rec.local.h))
  const inset = (v: number) =>
    v === 0
      ? 0
      : (Math.sign(v) * Math.max(1, Math.floor(Math.abs(v) * dpr + 1e-3))) / dpr
  return {
    ...rec,
    xform: [1, 0, 0, 1, x0, y0],
    local: { w, h },
    ...(rec.originInset
      ? {
          originInset: [
            inset(rec.originInset[0]),
            inset(rec.originInset[1]),
            inset(rec.originInset[2]),
            inset(rec.originInset[3])
          ] as [number, number, number, number]
        }
      : {})
  }
}

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
  const { x, y, w, h } = areaOf(rec)
  const box = { x, y, w, h }
  const [px, py] = rec.position

  if (natW === 0 || natH === 0) {
    return { rect: box, uv: FULL_UV, tile: NO_TILE, flags: 0 }
  }

  if (rec.originInset && rec.objectFit !== 'none') {
    // The painted area differs from the positioning area (background-clip
    // vs -origin): size the tile to the positioning area and sample by
    // local position, so a repeating image continues past its edge.
    const k =
      rec.objectFit === 'fill'
        ? null
        : (rec.objectFit === 'cover' ? Math.max : Math.min)(w / natW, h / natH)
    const tw = k === null ? w : natW * k
    const th = k === null ? h : natH * k
    return {
      rect: { x: 0, y: 0, w: rec.local.w, h: rec.local.h },
      uv: FULL_UV,
      tile: { x: x + (w - tw) * px, y: y + (h - th) * py, w: tw, h: th },
      flags: FLAG_UV_FROM_TILE | (rec.repeat ? FLAG_REPEAT : 0)
    }
  }

  if (rec.objectFit === 'none') {
    const rect = rec.originInset
      ? { x: 0, y: 0, w: rec.local.w, h: rec.local.h }
      : box
    const tile = {
      x: x + (w - natW) * px,
      y: y + (h - natH) * py,
      w: natW,
      h: natH
    }
    const flags = FLAG_UV_FROM_TILE | (rec.repeat ? FLAG_REPEAT : 0)
    return { rect, uv: FULL_UV, tile, flags }
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
