import { FRAME_WGSL } from '../gpu/frame'
import type { LayerPlace, RenderGraph } from '../gpu/graph'
import type { FrameContext } from '../types'
import { reportShaderErrors } from '../util/log'
import {
  createParams,
  type ParamBlock,
  type ParamSchema,
  type ParamValues
} from './params'
import { POINTER_WGSL } from './pointer'
import { readsTime } from './shader'
import type { Target } from './target'

// Layers: instanced quads with no DOM counterpart, drawn at a place in the
// scene's paint order (docs/EFFECTS.md "Layer"). The author owns a
// Float32Array of `count` × `stride` floats; the vertex hook places quad i
// from it, the fragment hook shades it. Contract: src/fx/README.md.

/** Bytes in the LayerFx uniform (see LAYER_WGSL). */
export const LAYER_FX_BYTES = 32

const LAYER_WGSL = /* wgsl */ `
struct LayerFx {
  time     : f32,    // page clock, s
  elapsed  : f32,    // s since this layer was last enabled
  dpr      : f32,
  count    : f32,    // instances drawn
  scroll   : vec2f,  // the real document scroll, CSS px
  viewport : vec2f,  // visible viewport, CSS px
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
  vertex: string
  /** WGSL defining `fn fragment(q : Quad, i : u32) -> vec4f`
   * (premultiplied). */
  fragment: string
  params?: S
  /** Default true. */
  enabled?: boolean
  /** Keep the frame loop running while enabled. Default false. */
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
  /** Upload `data` (its used prefix) on the next frame and request one. */
  markDirty(): void
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

function layerSource(o: LayerOptions, wgslParams: string): string {
  const stride = Math.max(1, Math.floor(o.stride))
  return [
    FRAME_WGSL,
    LAYER_WGSL,
    wgslParams,
    POINTER_WGSL,
    `const FX_STRIDE : u32 = ${stride}u;`,
    `const FX_SPACE : f32 = ${o.space === 'viewport' ? '1.0' : '0.0'};`,
    BINDINGS_WGSL,
    o.vertex,
    o.fragment,
    ENTRY_WGSL
  ].join('\n')
}

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
    continuous: o.continuous ?? readsTime(o.vertex, o.fragment),
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
  let dataDirty = true
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
  const module = device.createShaderModule({
    label,
    code: layerSource(o as LayerOptions, block.wgsl)
  })
  reportShaderErrors(module, label)
  const layout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'read-only-storage' }
      },
      ...[1, 2, 3].map(
        (binding): GPUBindGroupLayoutEntry => ({
          binding,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' }
        })
      )
    ]
  })
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
  const ensureData = (): void => {
    const bytes = Math.max(16, data.byteLength)
    if (dataBuf && dataBuf.size >= bytes) {
      return
    }
    dataBuf?.destroy()
    let size = 64
    while (size < bytes) {
      size *= 2
    }
    dataBuf = device.createBuffer({
      label: `${label}:data`,
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: dataBuf } },
        { binding: 1, resource: { buffer: fxBuf } },
        { binding: 2, resource: { buffer: paramsBuf } },
        { binding: 3, resource: { buffer: deps.pointerBuf } }
      ]
    })
    dataDirty = true
  }
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
        dataDirty = true
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
    markDirty() {
      dataDirty = true
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
    active: () => state.enabled && drawn > 0 && bindGroup !== null,
    draw(rp: GPURenderPassEncoder) {
      if (!bindGroup) {
        return
      }
      rp.setPipeline(pipeline)
      rp.setBindGroup(1, bindGroup)
      rp.draw(6, drawn)
    }
  }
  const removeExtra = graph.addLayer(extra)

  const state: LayerState = {
    handle,
    enabled: o.enabled ?? true,
    continuous: o.continuous ?? readsTime(o.vertex, o.fragment),
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
      if (dataDirty && dataBuf && count > 0) {
        const n = Math.min(count * stride, data.length)
        device.queue.writeBuffer(dataBuf, 0, data, 0, n)
        dataDirty = false
      }
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
      device.queue.writeBuffer(fxBuf, 0, f)
    },
    destroy() {
      removeExtra()
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
