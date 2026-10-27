import type { RegionFrame, RegionHandler, RenderGraph } from '../gpu/graph'
import { reportShaderErrors } from '../util/log'

// Distance fields (M5e; docs/EFFECTS.md, Distance fields): a signed
// distance to an element's rendered shape, built on the GPU by jump
// flooding from what its subtree draws (text, boxes, images, vector svgs:
// anything), for passes and layers to read with `sdf(p)`.
//
// The element is isolated (its subtree renders to its own texture, grown
// by `spread` on every side, as for a region pass). On a frame where its
// content or box changed, the handler seeds the field from that texture's
// coverage (alpha >= 0.5 inside), floods it in log2(size) steps and
// writes the signed distance in CSS px (negative inside) to an r16float
// texture over the grown box, at most `resolution` texels on its longer
// side; it composites the element unchanged. Other frames composite the
// group plainly and the field is kept. Reads beyond the field return
// `spread` past its edge.

export interface SdfOptions {
  /** CSS px the field reaches past the element (glows and outlines up to
   * this far). Default 32. */
  spread?: number
  /** Texels on the field's longer side, at most. Default 512. */
  resolution?: number
  /** A baked mask's name (`masks` in the bake config): its field, an
   * svg's shape computed offline, placed over the element's content box
   * (per the svg's viewBox and preserveAspectRatio) instead of built from
   * what the element draws. No isolation and no rebuilds; `spread` and
   * `resolution` are the baked ones. */
  mask?: string
}

export interface Sdf {
  readonly el: Element
  readonly spread: number
  readonly resolution: number
  /** True once the field has been built. */
  readonly ready: boolean
  /** Builds so far (one per content or box change). */
  readonly builds: number
  /** Rebuild on the next frame (content the runtime can't see change,
   * such as a canvas drawn into). */
  rebuild(): void
  destroy(): void
}

/** Bytes in the FxSdf uniform: rect (page CSS px), info. */
export const FX_SDF_BYTES = 32

/** WGSL declaring the field at (group, binding .. binding + 2) and
 * `sdf(p)` / `sdf_ready()`. */
export function sdfWgsl(group: number, binding: number): string {
  return /* wgsl */ `
struct FxSdf {
  rect : vec4f,   // runtime: the field's box, page CSS px (x, y, w, h)
  info : vec4f,   // runtime: ready, spread (CSS px), texel scale (0: 1), _
};
@group(${group}) @binding(${binding}) var fx_sdf : texture_2d<f32>;
@group(${group}) @binding(${binding + 1}) var fx_sdf_smp : sampler;
@group(${group}) @binding(${binding + 2}) var<uniform> fx_sdf_info : FxSdf;

// Signed distance from page point p (CSS px) to the element's rendered
// shape, CSS px: negative inside. Past the field, its edge's value plus
// the way out; before the first build, spread.
fn sdf(p : vec2f) -> f32 {
  let r = fx_sdf_info.rect;
  if (fx_sdf_info.info.x < 0.5 || r.z <= 0.0 || r.w <= 0.0) {
    return fx_sdf_info.info.y;
  }
  let q = clamp(p, r.xy, r.xy + r.zw);
  // Baked masks store viewBox units: info.z scales them to CSS px.
  let k = select(1.0, fx_sdf_info.info.z, fx_sdf_info.info.z > 0.0);
  let d = textureSampleLevel(fx_sdf, fx_sdf_smp, (q - r.xy) / r.zw, 0.0).r;
  return d * k + length(p - q);
}
fn sdf_ready() -> bool {
  return fx_sdf_info.info.x > 0.5;
}
`
}

// Seed: per field texel, its coverage from the source (the group
// texture: the most covered of the texels it spans); a boundary texel (inside, with an outside neighbour)
// stores its own position, the rest none (-1).
const SEED_WGSL = /* wgsl */ `
struct Seed { origin : vec2f, step : vec2f, size : vec2f, used : vec2f };
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var<uniform> u : Seed;

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn cov(t : vec2f) -> f32 {
  if (any(t < vec2f(0.0)) || any(t >= u.size)) {
    return 0.0;
  }
  // The most covered source texel under field texel t (k x k of them when
  // the field is smaller than the group, so a line thinner than a field
  // texel still counts); past the group's used region (a pooled texture
  // is larger, holding stale texels) is outside.
  let k = i32(u.step.x);
  let p0 = vec2i(floor(u.origin + t * u.step));
  let used = vec2i(u.used);
  var a = 0.0;
  for (var y = 0; y < k; y++) {
    for (var x = 0; x < k; x++) {
      let p = p0 + vec2i(x, y);
      if (all(p < used)) {
        a = max(a, textureLoad(src, p, 0).a);
      }
    }
  }
  return a;
}

@fragment
fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let t = floor(pos.xy);
  let a = cov(t);
  if (a < 0.5) {
    return vec4f(-1.0, -1.0, 0.0, 0.0);
  }
  let edge = cov(t + vec2f(1.0, 0.0)) < 0.5 || cov(t - vec2f(1.0, 0.0)) < 0.5 ||
    cov(t + vec2f(0.0, 1.0)) < 0.5 || cov(t - vec2f(0.0, 1.0)) < 0.5;
  // Inside texels carry 1 in .z (the sign).
  return select(vec4f(-1.0, -1.0, 1.0, 0.0), vec4f(t, 1.0, 0.0), edge);
}
`

// One jump-flood step: the nearest seed among the 3x3 at distance k.
const FLOOD_WGSL = /* wgsl */ `
struct Flood { k : f32, _p : vec3f };
@group(0) @binding(0) var cur : texture_2d<f32>;
@group(0) @binding(1) var<uniform> u : Flood;

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let t = floor(pos.xy);
  let n = vec2i(textureDimensions(cur)) - 1;
  let me = textureLoad(cur, vec2i(t), 0);
  var best = me;
  var bd = select(1e20, distance(me.xy, t), me.x >= 0.0);
  let k = i32(u.k);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let q = vec2i(t) + vec2i(x, y) * k;
      if (any(q < vec2i(0)) || any(q > n)) {
        continue;
      }
      let s = textureLoad(cur, q, 0);
      if (s.x < 0.0) {
        continue;
      }
      let d = distance(s.xy, t);
      if (d < bd) {
        bd = d;
        best = vec4f(s.xy, me.z, 0.0);
      }
    }
  }
  return vec4f(best.xy, me.z, 0.0);
}
`

// The signed distance in CSS px: to the boundary half a texel past the
// nearest seed's centre (inside negative).
const RESOLVE_WGSL = /* wgsl */ `
struct Resolve { css : f32, far : f32, _p : vec2f };
@group(0) @binding(0) var cur : texture_2d<f32>;
@group(0) @binding(1) var<uniform> u : Resolve;

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let t = floor(pos.xy);
  let s = textureLoad(cur, vec2i(t), 0);
  let inside = s.z > 0.5;
  if (s.x < 0.0) {
    // No seed at all: nothing drawn (far outside), or all inside.
    return vec4f(select(u.far, -u.far, inside), 0.0, 0.0, 0.0);
  }
  let d = distance(s.xy, t);
  let e = select(max(d - 0.5, 0.0), -(d + 0.5), inside) * u.css;
  return vec4f(e, 0.0, 0.0, 0.0);
}
`

// Composites the group unchanged (premultiplied over) on build frames.
const COPY_WGSL = /* wgsl */ `
struct Copy { origin : vec2f, alpha : f32, _p : f32 };
@group(1) @binding(0) var src : texture_2d<f32>;
@group(1) @binding(1) var<uniform> u : Copy;

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let n = vec2i(textureDimensions(src)) - 1;
  let s = vec2i(floor(pos.xy - u.origin));
  return textureLoad(src, clamp(s, vec2i(0), n), 0) * u.alpha;
}
`

export interface SdfDeps {
  device: GPUDevice
  format: GPUTextureFormat
  frameLayout: GPUBindGroupLayout
  graph: RenderGraph
}

/** What consumers (passes, layers, the frame loop) need of a field: a
 * live SdfField or a baked mask (sdf_mask.ts). */
export interface FieldSource {
  readonly el: Element
  readonly ready: boolean
  readonly builds: number
  /** Changes when the texture is replaced (bind groups re-made). */
  readonly generation: number
  view(): GPUTextureView
  readonly infoBuffer: GPUBuffer
  /** Each frame, after the read (`key`: the element's content and box). */
  check(key: string): void
  rebuild(): void
  destroy(): void
}

/** The field's GPU side: the region handler and the textures. */
export class SdfField implements FieldSource {
  ready = false
  builds = 0
  /** The field's box, page CSS px. */
  readonly rect = new Float32Array(4)
  private dirty = true
  private key = ''
  private field: GPUTexture | null = null
  private ping: GPUTexture[] = []
  private placeholder: GPUTexture | null = null
  private readonly info: GPUBuffer
  private readonly infoData = new Float32Array(FX_SDF_BYTES / 4)
  private version = 0
  private readonly seed: GPURenderPipeline
  private readonly flood: GPURenderPipeline
  private readonly resolve: GPURenderPipeline
  private readonly copy: GPURenderPipeline
  private readonly copyLayout: GPUBindGroupLayout
  private readonly uniforms: GPUBuffer[] = []
  private destroyed = false
  readonly handler: RegionHandler

  constructor(
    private readonly d: SdfDeps,
    readonly el: Element,
    readonly spread: number,
    readonly resolution: number
  ) {
    const { device } = d
    this.info = device.createBuffer({
      label: 'fx:sdf',
      size: FX_SDF_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    const pipe = (
      label: string,
      code: string,
      format: GPUTextureFormat
    ): GPURenderPipeline => {
      const module = device.createShaderModule({ label, code })
      reportShaderErrors(module, label)
      return device.createRenderPipeline({
        label,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' }
      })
    }
    this.seed = pipe('fx:sdf-seed', SEED_WGSL, 'rgba16float')
    this.flood = pipe('fx:sdf-flood', FLOOD_WGSL, 'rgba16float')
    this.resolve = pipe('fx:sdf-resolve', RESOLVE_WGSL, 'r16float')
    this.copyLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' }
        }
      ]
    })
    const copyModule = device.createShaderModule({
      label: 'fx:sdf-copy',
      code: COPY_WGSL
    })
    reportShaderErrors(copyModule, 'fx:sdf-copy')
    const blend: GPUBlendComponent = {
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add'
    }
    this.copy = device.createRenderPipeline({
      label: 'fx:sdf-copy',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [d.frameLayout, this.copyLayout]
      }),
      vertex: { module: copyModule, entryPoint: 'vs' },
      fragment: {
        module: copyModule,
        entryPoint: 'fs',
        targets: [{ format: d.format, blend: { color: blend, alpha: blend } }]
      },
      primitive: { topology: 'triangle-list' }
    })
    this.infoData[5] = spread
    device.queue.writeBuffer(this.info, 0, this.infoData)
    this.handler = {
      pad: () => this.spread,
      active: () => this.dirty && !this.destroyed,
      encode: (f) => this.build(f),
      composite: (rp, f) => this.composite(rp, f)
    }
  }

  /** Each frame, after the read: mark dirty when the element's content
   * or box changed (`key`). */
  check(key: string): void {
    if (key !== this.key) {
      this.key = key
      this.dirty = true
      this.d.graph.requestFrame()
    }
  }

  rebuild(): void {
    this.dirty = true
    this.d.graph.requestFrame()
  }

  /** Changes when the field texture is replaced (bind groups re-made). */
  get generation(): number {
    return this.version
  }

  view(): GPUTextureView {
    if (this.field) {
      return this.field.createView()
    }
    this.placeholder ??= this.d.device.createTexture({
      label: 'fx:sdf-none',
      size: [1, 1],
      format: 'r16float',
      usage: GPUTextureUsage.TEXTURE_BINDING
    })
    return this.placeholder.createView()
  }

  get infoBuffer(): GPUBuffer {
    return this.info
  }

  private uniform(i: number, data: Float32Array): GPUBuffer {
    let b = this.uniforms[i]
    if (!b) {
      b = this.d.device.createBuffer({
        label: `fx:sdf-u${i}`,
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      })
      this.uniforms[i] = b
    }
    this.d.device.queue.writeBuffer(b, 0, data)
    return b
  }

  private target(w: number, h: number): void {
    const f = this.field
    if (f && f.width === w && f.height === h) {
      return
    }
    f?.destroy()
    for (const t of this.ping) {
      t.destroy()
    }
    const { device } = this.d
    const make = (label: string, format: GPUTextureFormat): GPUTexture =>
      device.createTexture({
        label,
        size: { width: w, height: h },
        format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      })
    this.ping = [
      make('fx:sdf-a', 'rgba16float'),
      make('fx:sdf-b', 'rgba16float')
    ]
    this.field = make('fx:sdf', 'r16float')
    this.version++
  }

  private run(
    enc: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    out: GPUTexture,
    input: GPUTextureView,
    u: GPUBuffer
  ): void {
    const group = this.d.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: input },
        { binding: 1, resource: { buffer: u } }
      ]
    })
    const rp = enc.beginRenderPass({
      label: pipeline.label,
      colorAttachments: [
        {
          view: out.createView(),
          clearValue: { r: -1, g: -1, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    })
    rp.setPipeline(pipeline)
    rp.setBindGroup(0, group)
    rp.draw(3)
    rp.end()
  }

  private build(f: RegionFrame): void {
    const k = Math.max(
      1,
      Math.ceil(Math.max(f.width, f.height) / this.resolution)
    )
    const w = Math.max(1, Math.ceil(f.width / k))
    const h = Math.max(1, Math.ceil(f.height / k))
    this.target(w, h)
    const [a, b] = this.ping
    const field = this.field
    if (!a || !b || !field) {
      return
    }
    const enc = f.encoder
    this.run(
      enc,
      this.seed,
      a,
      f.source,
      this.uniform(0, new Float32Array([0, 0, k, k, w, h, f.width, f.height]))
    )
    let cur = a
    let next = b
    let i = 1
    for (
      let s = 2 ** Math.ceil(Math.log2(Math.max(w, h))) / 2;
      s >= 1;
      s /= 2
    ) {
      this.run(
        enc,
        this.flood,
        next,
        cur.createView(),
        this.uniform(i++, new Float32Array([s, 0, 0, 0]))
      )
      ;[cur, next] = [next, cur]
    }
    // Texels -> CSS px: k source texels per field texel, `scale` device
    // px per CSS px.
    const css = k / Math.max(f.scale, 1e-6)
    this.run(
      enc,
      this.resolve,
      field,
      cur.createView(),
      this.uniform(i++, new Float32Array([css, this.spread * 4, 0, 0]))
    )
    this.rect[0] = f.parentX + f.x / f.scale
    this.rect[1] = f.parentY + f.y / f.scale
    this.rect[2] = (w * k) / f.scale
    this.rect[3] = (h * k) / f.scale
    this.infoData.set(this.rect, 0)
    this.infoData[4] = 1
    this.infoData[5] = this.spread
    this.d.device.queue.writeBuffer(this.info, 0, this.infoData)
    this.ready = true
    this.builds++
    this.dirty = false
  }

  private composite(rp: GPURenderPassEncoder, f: RegionFrame): void {
    const u = this.uniform(15, new Float32Array([f.x, f.y, f.alpha, 0]))
    const group = this.d.device.createBindGroup({
      layout: this.copyLayout,
      entries: [
        { binding: 0, resource: f.source },
        { binding: 1, resource: { buffer: u } }
      ]
    })
    rp.setPipeline(this.copy)
    rp.setBindGroup(1, group)
    rp.draw(3)
  }

  destroy(): void {
    this.destroyed = true
    this.field?.destroy()
    for (const t of this.ping) {
      t.destroy()
    }
    this.placeholder?.destroy()
    this.info.destroy()
    for (const b of this.uniforms) {
      b.destroy()
    }
  }
}
