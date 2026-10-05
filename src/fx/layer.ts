import { FRAME_WGSL } from '../gpu/frame'
import type { LayerPlace, RenderGraph } from '../gpu/graph'
import type { GlyphRun } from '../scene/records'
import type { GlyphTable } from '../text/slug/rasterizer'
import { SLUG_COVERAGE_WGSL, SLUG_STRUCTS_WGSL } from '../text/slug/shaders'
import type { FrameContext } from '../types'
import { reportShaderErrors } from '../util/log'
import { type Hook, hookSource, LAYER_HOOKS } from './gpu'
import {
  createParams,
  type ParamBlock,
  type ParamSchema,
  type ParamValues
} from './params'
import { POINTER_WGSL } from './pointer'
import { readsTime } from './shader'
import { type Target, targetRuns } from './target'

// Layers: instanced quads with no DOM counterpart, drawn at a place in the
// scene's paint order (docs/EFFECTS.md "Layer"). The author owns a
// Float32Array of `count` × `stride` floats; the vertex hook places quad i
// from it, the fragment hook shades it. Contract: src/fx/README.md.

/** Bytes in the LayerFx uniform (see LAYER_WGSL). */
export const LAYER_FX_BYTES = 80

const LAYER_WGSL = /* wgsl */ `
struct LayerFx {
  time     : f32,    // page clock, s
  elapsed  : f32,    // s since this layer was last enabled
  dpr      : f32,
  count    : f32,    // instances drawn
  scroll   : vec2f,  // the real document scroll, CSS px
  viewport : vec2f,  // visible viewport, CSS px
  dt       : f32,    // s since the previous frame (clamped to 1/15)
  steps    : f32,    // simulate steps run since enabled (0 in the first)
  image_uv : vec4f,  // runtime: the image's texels in fx_image
  image_size : vec2f, // the image's texel size (0 when not ready)
  glyph_count : f32, // glyphs of the glyphs target
  _pad     : f32,
};

// What the vertex hook returns for one corner, interpolated for the
// fragment hook. pos is CSS px in the layer's space; the rest is free.
struct Quad {
  pos   : vec2f,
  uv    : vec2f,
  color : vec4f,
  extra : vec4f,
};
`

const BINDINGS_WGSL = /* wgsl */ `
@group(1) @binding(0) var<storage, read> fx_data : array<f32>;
@group(1) @binding(1) var<uniform> fx : LayerFx;
@group(1) @binding(2) var<uniform> params : Params;
@group(1) @binding(3) var<uniform> pointer : Pointer;
`

// The simulate module's bindings: the data is writable there.
const SIM_BINDINGS_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> fx_data : array<f32>;
@group(0) @binding(1) var<uniform> fx : LayerFx;
@group(0) @binding(2) var<uniform> params : Params;
@group(0) @binding(3) var<uniform> pointer : Pointer;

fn set_data(i : u32, k : u32, v : f32) {
  fx_data[i * FX_STRIDE + k] = v;
}
fn set_data2(i : u32, k : u32, v : vec2f) {
  set_data(i, k, v.x);
  set_data(i, k + 1u, v.y);
}
fn set_data4(i : u32, k : u32, v : vec4f) {
  set_data(i, k, v.x);
  set_data(i, k + 1u, v.y);
  set_data(i, k + 2u, v.z);
  set_data(i, k + 3u, v.w);
}
`

// With `image`: the target's pixels.
const IMAGE_WGSL = /* wgsl */ `
@group(1) @binding(4) var fx_image : texture_2d<f32>;
@group(1) @binding(5) var fx_image_smp : sampler;

// The image at uv (0..1 over it, y down), premultiplied, at mip level
// lod (> 0 can bleed across atlas neighbours). Transparent until decoded.
fn image_level(uv : vec2f, lod : f32) -> vec4f {
  let t = mix(fx.image_uv.xy, fx.image_uv.zw, clamp(uv, vec2f(0.0), vec2f(1.0)));
  let c = textureSampleLevel(fx_image, fx_image_smp, t, lod);
  return vec4f(c.rgb * c.a, c.a);
}
fn image(uv : vec2f) -> vec4f {
  return image_level(uv, 0.0);
}
`

// With `glyphs`: the target's mirrored glyphs, drawn through Slug.
const GLYPHS_WGSL = /* wgsl */ `
${SLUG_STRUCTS_WGSL}
@group(1) @binding(6) var<storage, read> fx_glyphs : array<Glyph>;
@group(1) @binding(7) var<storage, read> bands : array<Band>;
@group(1) @binding(8) var<storage, read> curves : array<Curve>;
@group(1) @binding(9) var<storage, read> fx_glyph_index : array<u32>;
${SLUG_COVERAGE_WGSL}
fn glyph_count() -> u32 {
  return u32(fx.glyph_count);
}
fn fx_glyph(k : u32) -> Glyph {
  let n = arrayLength(&fx_glyph_index);
  let i = fx_glyph_index[min(k, n - 1u)];
  var g = fx_glyphs[min(i, arrayLength(&fx_glyphs) - 1u)];
  if (k >= u32(fx.glyph_count) || i == 0xffffffffu) {
    g = Glyph();
  }
  return g;
}
// Ink box size, local CSS px.
fn glyph_size(k : u32) -> vec2f {
  return fx_glyph(k).rect.zw;
}
// Straight-alpha colour (the run's opacity applied).
fn glyph_color(k : u32) -> vec4f {
  return fx_glyph(k).color;
}
// Glyph space (offset.z: 1 viewport, 0 page) -> the layer's space.
fn fx_glyph_to_layer(g : Glyph, p : vec2f) -> vec2f {
  return p + (g.offset.z - FX_SPACE) * fx.scroll;
}
// The point at uv (0..1 over the ink box, y down) in the layer's space,
// CSS px: the glyph's transform and onGlyph offset applied.
fn glyph_point(k : u32, uv : vec2f) -> vec2f {
  let g = fx_glyph(k);
  let lp = g.rect.xy + uv * g.rect.zw;
  let m = g.xf0;
  return fx_glyph_to_layer(g,
    vec2f(m.x * lp.x + m.z * lp.y, m.y * lp.x + m.w * lp.y) +
    g.xf1.xy + g.offset.xy);
}
// The glyph's clip (its ancestors' overflow), min.xy max.zw in the
// layer's space. Not applied by the helpers: discard outside it to clip.
fn glyph_clip(k : u32) -> vec4f {
  let g = fx_glyph(k);
  return vec4f(fx_glyph_to_layer(g, g.clip.xy), fx_glyph_to_layer(g, g.clip.zw));
}
// Glyph k's coverage at uv (0..1 over the ink box, y down), anti-aliased
// from uv's screen derivatives: call it from the fragment hook in uniform
// control flow. 0 for a glyph Slug doesn't draw (emoji, fallback faces).
fn glyph_coverage(k : u32, uv : vec2f) -> f32 {
  let em = vec2f(uv.x, 1.0 - uv.y);
  let invPx = 1.0 / max(fwidth(em.x), 1e-5);
  let pxH = max(fwidth(em.y), 1e-5);
  let g = fx_glyph(k);
  var gref = g.gref;
  if (gref.y == 0u) {
    gref = vec4u(0u, 1u, 0u, 0u);
  }
  var sum = 0.0;
  for (var t = 0; t < 3; t = t + 1) {
    let off = (f32(t) + 0.5) / 3.0 - 0.5;
    sum = sum + abs(coverage_row(vec2f(em.x, em.y + off * pxH), gref, invPx));
  }
  return select(clamp(sum / 3.0, 0.0, 1.0), 0.0, g.gref.y == 0u);
}
`

const HELPERS_WGSL = /* wgsl */ `
// Float k of instance i.
fn data(i : u32, k : u32) -> f32 {
  return fx_data[i * FX_STRIDE + k];
}
fn data2(i : u32, k : u32) -> vec2f {
  return vec2f(data(i, k), data(i, k + 1u));
}
fn data4(i : u32, k : u32) -> vec4f {
  return vec4f(data(i, k), data(i, k + 1u), data(i, k + 2u), data(i, k + 3u));
}
// Viewport CSS px <-> page CSS px.
fn viewport_to_page(p : vec2f) -> vec2f {
  return p + fx.scroll;
}
fn page_to_viewport(p : vec2f) -> vec2f {
  return p - fx.scroll;
}
`

// Stand-ins when a tgpu.fn hook can't be resolved (already logged).
const DRAW_NOOP = /* wgsl */ `
fn vertex(i : u32, corner : vec2f) -> Quad {
  return Quad();
}
fn fragment(q : Quad, i : u32) -> vec4f {
  return vec4f(0.0);
}
`
const SIM_NOOP = 'fn simulate(i : u32) {}'

const SIM_ENTRY_WGSL = /* wgsl */ `
@compute @workgroup_size(64)
fn fx_cs(@builtin(global_invocation_id) id : vec3u) {
  // Rows of 65535 workgroups (the per-dimension limit).
  let i = id.x + id.y * (65535u * 64u);
  if (i >= u32(fx.count)) {
    return;
  }
  simulate(i);
}
`

const ENTRY_WGSL = /* wgsl */ `
struct FxOut {
  @builtin(position) clip : vec4f,
  @location(0) pos : vec2f,
  @location(1) uv : vec2f,
  @location(2) color : vec4f,
  @location(3) extra : vec4f,
  @location(4) @interpolate(flat) index : u32,
};

@vertex
fn fx_vs(@builtin(vertex_index) vi : u32,
         @builtin(instance_index) ii : u32) -> FxOut {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let q = vertex(ii, corners[vi]);
  var out : FxOut;
  out.clip = to_clip(q.pos, FX_SPACE);
  out.pos = q.pos;
  out.uv = q.uv;
  out.color = q.color;
  out.extra = q.extra;
  out.index = ii;
  return out;
}

@fragment
fn fx_fs(in : FxOut) -> @location(0) vec4f {
  return fragment(Quad(in.pos, in.uv, in.color, in.extra), in.index);
}
`

export interface LayerOptions<S extends ParamSchema = ParamSchema> {
  /** Labels the pipeline and shader errors. */
  name: string
  /** Instances drawn. */
  count: number
  /** Floats per instance in `data` (>= 1). */
  stride: number
  /** Initial data (copied into `layer.data` when it fits). */
  data?: Float32Array
  /** Default 'doc': positions are page CSS px. 'viewport': viewport CSS
   * px (fixed to the screen). */
  space?: 'doc' | 'viewport'
  /** Default 'above'. 'below' sits over the page background, under all
   * mirrored content; `{ after: target }` right after that element. */
  place?: 'above' | 'below' | { after: Target | Element }
  /** WGSL defining `fn vertex(i : u32, corner : vec2f) -> Quad`. */
  vertex: Hook
  /** WGSL defining `fn fragment(q : Quad, i : u32) -> vec4f`
   * (premultiplied). */
  fragment: Hook
  /** Sample this element's image record in the hooks: `image(uv)`,
   * `image_level(uv, lod)` (premultiplied). */
  image?: Target | Element
  /** Draw this element's mirrored glyphs: `glyph_count()`,
   * `glyph_point(k, uv)`, `glyph_size(k)`, `glyph_color(k)`,
   * `glyph_coverage(k, uv)` (k is the index into `target.glyphs`). */
  glyphs?: Target | Element
  /** WGSL defining `fn simulate(i : u32)`, run in a compute pass for
   * every instance each frame while enabled, before the layer draws. It
   * reads with `data*` and writes with `set_data*`; the state then lives
   * on the GPU, and `data` only seeds it (markDirty uploads). */
  simulate?: Hook
  params?: S
  /** Default true. */
  enabled?: boolean
  /** Keep the frame loop running while enabled. Default: true with
   * `simulate` or when a hook reads `fx.time`/`fx.elapsed`. */
  continuous?: boolean
  /** Called every frame while enabled, before upload: update `data`
   * (call markDirty) or params. `time` is the page clock, s. */
  update?: (layer: Layer<S>, time: number, ctx: FrameContext) => void
}

export interface Layer<S extends ParamSchema = ParamSchema> {
  readonly name: string
  readonly params: ParamValues<S>
  /** count × stride floats; grows when `count` does. Call markDirty()
   * after writing. */
  readonly data: Float32Array
  count: number
  readonly stride: number
  place: 'above' | 'below' | { after: Target | Element }
  enabled: boolean
  continuous: boolean
  /** `simulate` steps dispatched since last enabled. */
  readonly steps: number
  /** Upload `data` on the next frame and request one: instances
   * [first, first + n), default all `count`. With `simulate` this
   * overwrites their GPU state. */
  markDirty(first?: number, n?: number): void
  destroy(): void
}

/** What a Layer needs from the runtime (effects.ts). */
export interface LayerDeps {
  device: GPUDevice
  format: GPUTextureFormat
  frameLayout: GPUBindGroupLayout
  graph: RenderGraph
  pointerBuf: GPUBuffer
  /** Page clock, s (or the test override). */
  time(): number
  /** Every effect's elapsed override, s, or null. */
  elapsedOverride(): number | null
  /** The simulate step override, s, or null. */
  dtOverride(): number | null
  /** The frame loop: request a frame. */
  wake(): void
}

/** Runtime-side state of a Layer (effects.ts drives it). */
export interface LayerState {
  handle: Layer<ParamSchema>
  enabled: boolean
  continuous: boolean
  /** Per-frame: update hook, uploads. */
  frame(ctx: FrameContext): void
  destroy(): void
}

const toPlace = (
  p: 'above' | 'below' | { after: Target | Element }
): LayerPlace =>
  typeof p === 'string'
    ? p
    : { after: p.after instanceof Element ? p.after : p.after.el }

function layerSource(
  o: LayerOptions,
  wgslParams: string,
  hooks: string
): string {
  const stride = Math.max(1, Math.floor(o.stride))
  return [
    FRAME_WGSL,
    LAYER_WGSL,
    wgslParams,
    POINTER_WGSL,
    `const FX_STRIDE : u32 = ${stride}u;`,
    `const FX_SPACE : f32 = ${o.space === 'viewport' ? '1.0' : '0.0'};`,
    BINDINGS_WGSL,
    o.image ? IMAGE_WGSL : '',
    o.glyphs ? GLYPHS_WGSL : '',
    HELPERS_WGSL,
    hooks,
    ENTRY_WGSL
  ].join('\n')
}

function simulateSource(
  o: LayerOptions,
  wgslParams: string,
  hooks: string
): string {
  const stride = Math.max(1, Math.floor(o.stride))
  return [
    LAYER_WGSL,
    wgslParams,
    POINTER_WGSL,
    `const FX_STRIDE : u32 = ${stride}u;`,
    SIM_BINDINGS_WGSL,
    HELPERS_WGSL,
    hooks,
    SIM_ENTRY_WGSL
  ].join('\n')
}

const layerContinuous = (o: LayerOptions, hooks?: string): boolean =>
  o.continuous ??
  (o.simulate !== undefined || readsTime(hooks ?? o.vertex, o.fragment))

/** A Layer whose GPU side is absent (inert runtime). */
export function inertLayer<S extends ParamSchema>(
  o: LayerOptions<S>
): Layer<S> {
  const block = createParams(o.params ?? ({} as S), () => {})
  const stride = Math.max(1, Math.floor(o.stride))
  let data = new Float32Array(Math.max(0, o.count) * stride)
  if (o.data && o.data.length <= data.length) {
    data.set(o.data)
  }
  let count = o.count
  return {
    name: o.name,
    params: block.values as ParamValues<S>,
    get data() {
      return data
    },
    get count() {
      return count
    },
    set count(n: number) {
      count = Math.max(0, Math.floor(n))
      if (count * stride > data.length) {
        const next = new Float32Array(count * stride)
        next.set(data)
        data = next
      }
    },
    stride,
    place: o.place ?? 'above',
    enabled: o.enabled ?? true,
    continuous: layerContinuous(o as LayerOptions),
    steps: 0,
    markDirty() {},
    destroy() {}
  }
}

/** Create a Layer on the GPU and register it with the graph. */
export function createLayer<S extends ParamSchema>(
  o: LayerOptions<S>,
  deps: LayerDeps,
  onRemove: (s: LayerState) => void
): LayerState {
  const { device, format, frameLayout, graph } = deps
  const stride = Math.max(1, Math.floor(o.stride))
  let enabledAt: number | null = null
  // Instance ranges [lo, hi) to upload. Kept apart, not merged into one
  // span: with simulate an upload resets GPU state, so instances between
  // two marked ranges must not be rewritten.
  let dirty: [number, number][] = [[0, Number.POSITIVE_INFINITY]]
  const markRange = (lo: number, hi: number): void => {
    if (hi > lo) {
      dirty.push([lo, hi])
    }
    // Marked many times while disabled (no frame drains it).
    if (dirty.length > 64) {
      dirty = mergeRanges(dirty, Number.POSITIVE_INFINITY)
    }
  }
  const sim = o.simulate !== undefined
  let lastTime: number | null = null
  let steps = 0
  let count = Math.max(0, Math.floor(o.count))
  let data = new Float32Array(Math.max(1, count) * stride)
  if (o.data && o.data.length <= data.length) {
    data.set(o.data)
  }
  let place = o.place ?? 'above'
  let destroyed = false
  // Inside update(): the frame is already running, so writes must not
  // request another (the loop would never idle).
  let inFrame = false
  /** Instances uploaded for this frame (count can change after). */
  let drawn = 0
  const wake = (): void => {
    if (!inFrame) {
      deps.wake()
    }
  }

  const block = createParams(o.params ?? ({} as S), () => {
    if (state.enabled) {
      wake()
    }
  }) as unknown as ParamBlock<ParamSchema>
  const label = `fx:${o.name}`
  const hooks =
    hookSource(o.name, [
      [o.vertex, LAYER_HOOKS.vertex],
      [o.fragment, LAYER_HOOKS.fragment]
    ]) ?? DRAW_NOOP
  const module = device.createShaderModule({
    label,
    code: layerSource(o as LayerOptions, block.wgsl, hooks)
  })
  reportShaderErrors(module, label)
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
  const elOf = (x: Target | Element | undefined): Element | null =>
    x === undefined ? null : x instanceof Element ? x : x.el
  const imageEl = elOf(o.image)
  const glyphEl = elOf(o.glyphs)
  const storage = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: VF,
    buffer: { type: 'read-only-storage' }
  })
  const layout = device.createBindGroupLayout({
    entries: [
      storage(0),
      ...[1, 2, 3].map(
        (binding): GPUBindGroupLayoutEntry => ({
          binding,
          visibility: VF,
          buffer: { type: 'uniform' }
        })
      ),
      ...(imageEl
        ? [
            { binding: 4, visibility: VF, texture: {} },
            { binding: 5, visibility: VF, sampler: {} }
          ]
        : []),
      ...(glyphEl ? [6, 7, 8, 9].map(storage) : [])
    ]
  })
  const res = sideResources(device, label, imageEl !== null, glyphEl !== null)
  const blend: GPUBlendState = {
    color: {
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add'
    },
    alpha: {
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add'
    }
  }
  const pipeline = device.createRenderPipeline({
    label,
    layout: device.createPipelineLayout({
      bindGroupLayouts: [frameLayout, layout]
    }),
    vertex: { module, entryPoint: 'fx_vs' },
    fragment: {
      module,
      entryPoint: 'fx_fs',
      targets: [{ format, blend }]
    },
    primitive: { topology: 'triangle-list' }
  })
  const fxBuf = device.createBuffer({
    label: `${label}:fx`,
    size: LAYER_FX_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  const paramsBuf = device.createBuffer({
    label: `${label}:params`,
    size: block.byteSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  device.queue.writeBuffer(paramsBuf, 0, block.pack())
  let dataBuf: GPUBuffer | null = null
  let bindGroup: GPUBindGroup | null = null
  let simPipeline: GPUComputePipeline | null = null
  let simLayout: GPUBindGroupLayout | null = null
  let simGroup: GPUBindGroup | null = null
  if (sim) {
    const simModule = device.createShaderModule({
      label: `${label}:simulate`,
      code: simulateSource(
        o as LayerOptions,
        block.wgsl,
        hookSource(o.name, [[o.simulate, LAYER_HOOKS.simulate]]) ?? SIM_NOOP
      )
    })
    reportShaderErrors(simModule, `${label}:simulate`)
    simLayout = device.createBindGroupLayout({
      label: `${label}:simulate`,
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'storage' }
        },
        ...[1, 2, 3].map(
          (binding): GPUBindGroupLayoutEntry => ({
            binding,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: 'uniform' }
          })
        )
      ]
    })
    simPipeline = device.createComputePipeline({
      label: `${label}:simulate`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [simLayout] }),
      compute: { module: simModule, entryPoint: 'fx_cs' }
    })
  }
  const ensureData = (): void => {
    const bytes = Math.max(16, data.byteLength)
    if (dataBuf && dataBuf.size >= bytes) {
      return
    }
    const old = dataBuf
    let size = 64
    while (size < bytes) {
      size *= 2
    }
    dataBuf = device.createBuffer({
      label: `${label}:data`,
      size,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC
    })
    if (old && sim) {
      // The state lives on the GPU: carry it over; new instances are
      // seeded from `data` (the grow marked them dirty).
      const enc = device.createCommandEncoder({ label: `${label}:grow` })
      enc.copyBufferToBuffer(old, 0, dataBuf, 0, old.size)
      device.queue.submit([enc.finish()])
    } else {
      markRange(0, Number.POSITIVE_INFINITY)
    }
    old?.destroy()
    if (simLayout) {
      simGroup = device.createBindGroup({
        layout: simLayout,
        entries: [
          { binding: 0, resource: { buffer: dataBuf } },
          { binding: 1, resource: { buffer: fxBuf } },
          { binding: 2, resource: { buffer: paramsBuf } },
          { binding: 3, resource: { buffer: deps.pointerBuf } }
        ]
      })
    }
    bindGroup = null
  }
  // The bind group's inputs; rebuilt when one changes (draw time: an
  // image atlas grow or a text buffer grow replaces them).
  let bound: unknown[] = []
  const currentGroup = (): GPUBindGroup | null => {
    if (!dataBuf) {
      return null
    }
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: dataBuf } },
      { binding: 1, resource: { buffer: fxBuf } },
      { binding: 2, resource: { buffer: paramsBuf } },
      { binding: 3, resource: { buffer: deps.pointerBuf } }
    ]
    const key: unknown[] = [dataBuf]
    if (imageEl || glyphEl) {
      side.fill(0)
    }
    if (imageEl && res.image) {
      const r = graph.imageOf(imageEl)
      const view = r?.view ?? res.image.view
      if (r) {
        side.set(r.uv, 0)
        side[4] = r.width
        side[5] = r.height
      }
      entries.push(
        { binding: 4, resource: view },
        { binding: 5, resource: res.image.sampler }
      )
      key.push(view)
    }
    if (glyphEl && res.glyphs) {
      const table = graph.glyphTable()
      const node = graph.nodeOf(glyphEl)
      const idx = glyphIndex.fill(table, node ? targetRuns(node) : [])
      side[6] = idx.count
      const g = table ?? res.glyphs
      entries.push(
        { binding: 6, resource: { buffer: g.glyphs } },
        { binding: 7, resource: { buffer: g.bands } },
        { binding: 8, resource: { buffer: g.curves } },
        { binding: 9, resource: { buffer: idx.buffer } }
      )
      key.push(g.glyphs, g.bands, g.curves, idx.buffer)
    }
    if (imageEl || glyphEl) {
      device.queue.writeBuffer(fxBuf, 48, side)
    }
    if (
      !bindGroup ||
      key.length !== bound.length ||
      key.some((k, i) => k !== bound[i])
    ) {
      bound = key
      bindGroup = device.createBindGroup({ label, layout, entries })
    }
    return bindGroup
  }
  const side = new Float32Array(8)
  const glyphIndex = new GlyphIndex(device, label)
  const fxData = new Float32Array(LAYER_FX_BYTES / 4)

  const handle: Layer<ParamSchema> = {
    name: o.name,
    params: block.values,
    get data() {
      return data
    },
    get count() {
      return count
    },
    set count(n: number) {
      const next = Math.max(0, Math.floor(n))
      if (next * stride > data.length) {
        const grown = new Float32Array(next * stride)
        grown.set(data)
        data = grown
      }
      if (next > count) {
        markRange(count, next)
      }
      count = next
      wake()
    },
    stride,
    get place() {
      return place
    },
    set place(p) {
      place = p
      extra.place = toPlace(p)
      graph.replace()
    },
    get enabled() {
      return state.enabled
    },
    set enabled(on: boolean) {
      if (on === state.enabled) {
        return
      }
      state.enabled = on
      if (on) {
        enabledAt = null
        lastTime = null
        steps = 0
      }
      wake()
    },
    get continuous() {
      return state.continuous
    },
    set continuous(on: boolean) {
      if (on === state.continuous) {
        return
      }
      state.continuous = on
      wake()
    },
    get steps() {
      return steps
    },
    markDirty(first = 0, n = Number.POSITIVE_INFINITY) {
      const lo = Math.max(0, Math.floor(first))
      markRange(lo, lo + Math.max(0, Math.ceil(n)))
      if (state.enabled) {
        wake()
      }
    },
    destroy() {
      if (destroyed) {
        return
      }
      destroyed = true
      onRemove(state)
      state.destroy()
    }
  }

  const extra = {
    place: toPlace(place),
    active: () => state.enabled && drawn > 0 && dataBuf !== null,
    draw(rp: GPURenderPassEncoder) {
      const group = currentGroup()
      if (!group) {
        return
      }
      rp.setPipeline(pipeline)
      rp.setBindGroup(1, group)
      rp.draw(6, drawn)
    }
  }
  const removeExtra = graph.addLayer(extra)

  const state: LayerState = {
    handle,
    enabled: o.enabled ?? true,
    continuous: layerContinuous(o as LayerOptions, hooks),
    frame(ctx) {
      if (!state.enabled) {
        return
      }
      enabledAt ??= ctx.time
      const time = deps.time()
      inFrame = true
      try {
        o.update?.(handle as unknown as Layer<S>, time, ctx)
      } finally {
        inFrame = false
      }
      ensureData()
      if (dataBuf) {
        for (const [lo, hi] of mergeRanges(dirty, count)) {
          device.queue.writeBuffer(
            dataBuf,
            lo * stride * 4,
            data,
            lo * stride,
            (hi - lo) * stride
          )
        }
      }
      dirty = []
      drawn = count
      if (block.dirty) {
        device.queue.writeBuffer(paramsBuf, 0, block.pack())
      }
      const f = fxData
      f[0] = time
      f[1] = deps.elapsedOverride() ?? (ctx.time - enabledAt) / 1000
      f[2] = graph.shared.dpr
      f[3] = drawn
      f[4] = ctx.scrollX
      f[5] = ctx.scrollY
      f[6] = ctx.width
      f[7] = ctx.height
      const dtOverride = deps.dtOverride()
      f[8] =
        dtOverride ??
        (lastTime === null ? 0 : Math.min(Math.max(time - lastTime, 0), 1 / 15))
      f[9] = steps
      lastTime = time
      device.queue.writeBuffer(fxBuf, 0, f)
      if (simPipeline && simGroup && drawn > 0) {
        const enc = device.createCommandEncoder({ label: `${label}:simulate` })
        const cp = enc.beginComputePass({ label: `${label}:simulate` })
        cp.setPipeline(simPipeline)
        cp.setBindGroup(0, simGroup)
        const groups = Math.ceil(drawn / 64)
        cp.dispatchWorkgroups(
          Math.min(groups, 65535),
          Math.ceil(groups / 65535)
        )
        cp.end()
        device.queue.submit([enc.finish()])
        steps++
      }
    },
    destroy() {
      removeExtra()
      res.destroy()
      glyphIndex.destroy()
      dataBuf?.destroy()
      fxBuf.destroy()
      paramsBuf.destroy()
      bindGroup = null
    }
  }
  if (state.enabled) {
    wake()
  }
  return state
}

/** `ranges` clamped to [0, count), sorted, overlapping or touching ones
 * merged. */
function mergeRanges(
  ranges: readonly [number, number][],
  count: number
): [number, number][] {
  const out: [number, number][] = []
  const sorted = ranges
    .map(([lo, hi]): [number, number] => [Math.max(0, lo), Math.min(hi, count)])
    .filter(([lo, hi]) => hi > lo)
    .sort((a, b) => a[0] - b[0])
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1])
    } else {
      out.push(r)
    }
  }
  return out
}

/** Placeholders bound while a layer's image or glyphs aren't available. */
function sideResources(
  device: GPUDevice,
  label: string,
  image: boolean,
  glyphs: boolean
) {
  const tex = image
    ? device.createTexture({
        label: `${label}:no-image`,
        size: [1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING
      })
    : null
  const buf = (size: number): GPUBuffer =>
    device.createBuffer({
      label: `${label}:no-glyphs`,
      size,
      usage: GPUBufferUsage.STORAGE
    })
  // At least one element of each array (Glyph is 112 bytes).
  const g = glyphs
    ? { glyphs: buf(112), bands: buf(16), curves: buf(32) }
    : null
  return {
    image: tex &&
      image && {
        view: tex.createView(),
        sampler: device.createSampler({
          magFilter: 'linear',
          minFilter: 'linear',
          mipmapFilter: 'linear'
        })
      },
    glyphs: g,
    destroy() {
      tex?.destroy()
      g?.glyphs.destroy()
      g?.bands.destroy()
      g?.curves.destroy()
    }
  }
}

/** Target glyph k -> Slug instance index, rebuilt every draw. */
class GlyphIndex {
  buffer: GPUBuffer
  private data = new Uint32Array(64)
  constructor(
    private readonly device: GPUDevice,
    private readonly label: string
  ) {
    this.buffer = this.alloc(this.data.byteLength)
  }

  private alloc(size: number): GPUBuffer {
    return this.device.createBuffer({
      label: `${this.label}:glyph-index`,
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
  }

  fill(
    table: GlyphTable | null,
    runs: readonly GlyphRun[]
  ): { buffer: GPUBuffer; count: number } {
    let n = 0
    if (table) {
      for (const run of runs) {
        n += run.glyphs.length
      }
    }
    if (n > this.data.length) {
      let size = this.data.length
      while (size < n) {
        size *= 2
      }
      this.data = new Uint32Array(size)
      this.buffer.destroy()
      this.buffer = this.alloc(this.data.byteLength)
    }
    let k = 0
    if (table) {
      for (const run of runs) {
        const s = table.start(run)
        for (let j = 0; j < run.glyphs.length; j++) {
          // No instance (not in the last upload): a zero glyph.
          this.data[k++] = s === undefined ? 0xffffffff : s + j
        }
      }
    }
    if (k > 0) {
      this.device.queue.writeBuffer(this.buffer, 0, this.data, 0, k)
    }
    return { buffer: this.buffer, count: k }
  }

  destroy(): void {
    this.buffer.destroy()
  }
}
