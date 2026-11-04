import tgpu, { type TgpuRoot } from 'typegpu'
import * as d from 'typegpu/data'
import { resolveShader } from '../gpu/frame'
import {
  bindEntries,
  floatOffsets,
  gpuLayout,
  passExternals,
  structWgsl
} from '../gpu/schema'
import type { FrameContext, PointerState } from '../types'
import { reportShaderErrors } from '../util/log'
import { Lifecycle } from './lifecycle'
import {
  createParams,
  type ParamBlock,
  type ParamSchema,
  type ParamValues
} from './params'

// Trails: a viewport-space field of the pointer's recent motion, kept on
// the GPU (docs/EFFECTS.md "Trail"). Each frame a compute pass fades every
// cell and deposits the pointer's velocity along the segment it moved
// since the last frame. Passes, materials and layers given `trail` read it
// with trail_at(p) and friends (TRAIL_WGSL). Contract: src/fx/README.md
// "Trails".

/** The field's size, for consumers (`fx_trail_info`). */
const TrailInfoData = d
  .struct({
    /** Cells. */
    grid: d.vec2f,
    /** CSS px per cell. */
    cell: d.f32,
    _pad: d.f32
  })
  .$name('FxTrailInfo')

/** One step of the field (STEP_WGSL's `st`). */
const StepData = d
  .struct({
    /** Cells. */
    grid: d.vec2f,
    /** CSS px per cell. */
    cell: d.f32,
    /** Fraction kept this frame. */
    keep: d.f32,
    /** Stroke start, viewport CSS px. */
    a: d.vec2f,
    /** Stroke end. */
    b: d.vec2f,
    /** Unit direction (zero when still). */
    dir: d.vec2f,
    /** Brush radius, CSS px. */
    radius: d.f32,
    /** Deposit at the stroke's centre line (0: fade only). */
    amount: d.f32
  })
  .$name('Step')

const stepLayout = tgpu
  .bindGroupLayout({
    field: {
      storage: d.arrayOf(d.vec4f),
      access: 'mutable',
      visibility: ['compute']
    },
    st: { uniform: StepData, visibility: ['compute'] }
  })
  .$idx(0)

/** Bytes in the FxTrailInfo uniform consumers bind. */
export const TRAIL_INFO_BYTES = d.sizeOf(TrailInfoData)
const INFO_AT = floatOffsets(TrailInfoData)
const STEP_BYTES = d.sizeOf(StepData)
const STEP_AT = floatOffsets(StepData)
/** Below this the field counts as empty: no dispatch, cleared once. */
const EPS = 1e-3

const schema = {
  radius: { type: 'f32', default: 80, min: 4, max: 400 },
  decay: { type: 'f32', default: 0.92, min: 0, max: 0.999 },
  strength: { type: 'f32', default: 1, min: 0, max: 4 },
  speed: { type: 'f32', default: 1500, min: 50, max: 6000 },
  gamma: { type: 'f32', default: 1, min: 0.25, max: 4 }
} as const satisfies ParamSchema

export type TrailSchema = typeof schema

export interface TrailOptions {
  /** Labels the compute pipeline and shader errors. Default 'trail'. */
  name?: string
  /** CSS px per field cell (the field's resolution). Default 16. */
  cell?: number
  /** Brush radius, CSS px. Default 80. */
  radius?: number
  /** Fraction kept per 60 Hz frame (frame-rate independent). Default 0.92. */
  decay?: number
  /** Deposit gain. Default 1. */
  strength?: number
  /** Pointer speed, CSS px/s, that deposits `strength` per frame.
   * Default 1500. */
  speed?: number
  /** Response curve on speed / `speed` (> 1: slow moves leave less).
   * Default 1. */
  gamma?: number
  /** Follow the pointer. Off, only stroke() deposits. Default true. */
  pointer?: boolean
  /** Default true. */
  enabled?: boolean
}

export interface Trail {
  readonly name: string
  /** radius, decay, strength, speed, gamma (live). */
  readonly params: ParamValues<TrailSchema>
  readonly schema: TrailSchema
  /** CSS px per cell. */
  readonly cell: number
  /** Off: no deposits, no decay; the field keeps its contents. */
  enabled: boolean
  /** Deposit from the pointer. */
  pointer: boolean
  /** Something is left in the field (it still fades). */
  readonly active: boolean
  /** Deposit a stroke from `a` to `b` (viewport CSS px) on the next
   * frame, as if the pointer had moved there at `speed` CSS px/s for one
   * 60 Hz frame, whatever the frame rate (default `params.speed`, a
   * full-strength stroke). */
  stroke(
    a: { x: number; y: number },
    b: { x: number; y: number },
    speed?: number
  ): void
  /** Empty the field. */
  clear(): void
  /** Stop and empty it; consumers then read zeros. */
  destroy(): void
}

/** What a consumer binds: the field and its info uniform. `version`
 * changes when the field buffer is replaced (rebuild bind groups). */
export interface TrailBinding {
  field: GPUBuffer
  info: GPUBuffer
  version: number
}

/** Runtime-side state of a Trail (effects.ts drives it). */
export interface TrailState {
  handle: Trail
  life: Lifecycle
  /** Fade and deposit for this frame (before anything that reads it). */
  frame(ctx: FrameContext, pointer: PointerState): void
  /** Still fading: keep frames coming. */
  live(): boolean
  binding(): TrailBinding
  /** Free GPU resources (runtime teardown). */
  free(): void
}

const states = new WeakMap<Trail, TrailState>()

/** The runtime state behind a Trail handle (null for an inert one). */
export function trailState(t: Trail | undefined): TrailState | null {
  return t ? (states.get(t) ?? null) : null
}

/**
 * The field's declarations and readers for a consumer that binds it at
 * (group, binding) and (group, binding + 1). Channels: xy the deposited
 * direction × amount (y down), z the amount (speed-weighted, up to 4),
 * w presence (1 under the brush while moving, whatever the speed).
 */
export function trailWgsl(group: number, binding: number): string {
  return /* wgsl */ `
${structWgsl(TrailInfoData)}
@group(${group}) @binding(${binding}) var<storage, read> fx_trail : array<vec4f>;
@group(${group}) @binding(${binding + 1}) var<uniform> fx_trail_info : FxTrailInfo;

fn fx_trail_cell(c : vec2i) -> vec4f {
  let g = vec2i(fx_trail_info.grid);
  if (any(c < vec2i(0)) || any(c >= g)) {
    return vec4f(0.0);
  }
  return fx_trail[u32(c.y * g.x + c.x)];
}
// The trail at p (viewport CSS px), bilinear between cell centres.
fn trail_at(p : vec2f) -> vec4f {
  let q = p / max(fx_trail_info.cell, 1.0) - 0.5;
  let i = vec2i(floor(q));
  let f = fract(q);
  let a = mix(fx_trail_cell(i), fx_trail_cell(i + vec2i(1, 0)), f.x);
  let b = mix(fx_trail_cell(i + vec2i(0, 1)), fx_trail_cell(i + vec2i(1, 1)), f.x);
  return mix(a, b, f.y);
}
// The cell containing p, unfiltered (blocky looks).
fn trail_cell(p : vec2f) -> vec4f {
  return fx_trail_cell(vec2i(floor(p / max(fx_trail_info.cell, 1.0))));
}
// CSS px per cell, and the top-left corner of the cell containing p.
fn trail_cell_size() -> f32 {
  return fx_trail_info.cell;
}
fn trail_snap(p : vec2f) -> vec2f {
  let c = max(fx_trail_info.cell, 1.0);
  return floor(p / c) * c;
}
`
}

const STEP_WGSL: string = resolveShader(
  /* wgsl */ `
@compute @workgroup_size(8, 8)
fn fx_trail_cs(@builtin(global_invocation_id) id : vec3u) {
  let g = vec2u(st.grid);
  if (id.x >= g.x || id.y >= g.y) {
    return;
  }
  let i = id.y * g.x + id.x;
  var v = field[i] * st.keep;
  if (st.amount > 0.0) {
    let c = (vec2f(id.xy) + 0.5) * st.cell;
    let ab = st.b - st.a;
    let t = clamp(dot(c - st.a, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
    let d = distance(c, st.a + ab * t);
    let f = 1.0 - smoothstep(0.0, max(st.radius, 1.0), d);
    let k = st.amount * f * f;
    v = vec4f(v.xy + st.dir * k, min(v.z + k, 4.0), max(v.w, f));
  }
  field[i] = v;
}
`,
  passExternals(stepLayout, { Step: StepData })
)

/** A Trail with no GPU side (inert runtime). */
export function inertTrail(o: TrailOptions = {}): Trail {
  const block = createParams(schema, () => {})
  applyOptions(block, o)
  const life = new Lifecycle({
    enabled: o.enabled ?? true,
    continuous: null,
    timed: false,
    wake: () => {}
  })
  return {
    name: o.name ?? 'trail',
    params: block.values,
    schema,
    cell: cellOf(o),
    get enabled() {
      return life.enabled
    },
    set enabled(on: boolean) {
      life.setEnabled(on)
    },
    pointer: o.pointer ?? true,
    active: false,
    stroke() {},
    clear() {},
    destroy() {
      life.destroy()
    }
  }
}

const cellOf = (o: TrailOptions): number =>
  Math.max(2, Math.round(o.cell ?? 16))

function applyOptions(block: ParamBlock<TrailSchema>, o: TrailOptions): void {
  const p = block.values
  for (const k of Object.keys(schema) as (keyof TrailSchema)[]) {
    const v = o[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
}

export interface TrailDeps {
  device: GPUDevice
  root: TgpuRoot
  /** The frame loop: request a frame. */
  wake(): void
}

export function createTrail(
  o: TrailOptions,
  deps: TrailDeps,
  onRemove: (s: TrailState) => void
): TrailState {
  const { device } = deps
  const name = o.name ?? 'trail'
  const label = `fx:${name}`
  const cell = cellOf(o)
  const life: Lifecycle = new Lifecycle({
    enabled: o.enabled ?? true,
    continuous: null,
    timed: false,
    wake: deps.wake,
    toggled: () => {
      prev = null
    },
    busy: () => life.enabled && handle.active
  })
  // Writes before the trail is ready (applyOptions) wake nothing.
  let ready = false
  const block = createParams(schema, () => {
    if (ready) {
      life.paramsChanged()
    }
  })
  applyOptions(block, o)
  const p = block.values

  const module = device.createShaderModule({ label, code: STEP_WGSL })
  reportShaderErrors(module, label)
  const layout = gpuLayout(deps.root, stepLayout)
  const pipeline = device.createComputePipeline({
    label,
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module, entryPoint: 'fx_trail_cs' }
  })
  const stepBuf = device.createBuffer({
    label: `${label}:step`,
    size: STEP_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  const info = device.createBuffer({
    label: `${label}:info`,
    size: TRAIL_INFO_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  const step = new Float32Array(STEP_BYTES / 4)
  const infoData = new Float32Array(TRAIL_INFO_BYTES / 4)

  let field: GPUBuffer = device.createBuffer({
    label: `${label}:field`,
    size: 16,
    usage:
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
  })
  let group: GPUBindGroup | null = null
  let version = 0
  let cols = 0
  let rows = 0
  /** A rough upper bound of what's in the field (decays like it). */
  let energy = 0
  /** The field was zeroed since it last held anything. */
  let empty = true
  let prev: { x: number; y: number } | null = null
  // `t`: the frame length the deposit is scaled to (stroke() uses a fixed
  // 1/60 s so a scripted stroke deposits the same at any frame rate).
  let pending: {
    a: [number, number]
    b: [number, number]
    s: number
    t: number
  }[] = []

  const writeInfo = (): void => {
    infoData[INFO_AT.grid] = life.destroyed ? 0 : cols
    infoData[INFO_AT.grid + 1] = life.destroyed ? 0 : rows
    infoData[INFO_AT.cell] = cell
    infoData[INFO_AT._pad] = 0
    device.queue.writeBuffer(info, 0, infoData)
  }
  writeInfo()

  /** Size the field to the viewport (contents reset on a change). */
  const fit = (width: number, height: number): void => {
    const c = Math.max(1, Math.ceil(width / cell))
    const r = Math.max(1, Math.ceil(height / cell))
    if (c === cols && r === rows) {
      return
    }
    cols = c
    rows = r
    const bytes = cols * rows * 16
    if (field.size < bytes) {
      let size = 64
      while (size < bytes) {
        size *= 2
      }
      field.destroy()
      field = device.createBuffer({
        label: `${label}:field`,
        size,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC
      })
      version++
      group = null
    }
    zero()
    writeInfo()
  }

  const zero = (): void => {
    const enc = device.createCommandEncoder({ label: `${label}:clear` })
    enc.clearBuffer(field)
    device.queue.submit([enc.finish()])
    energy = 0
    empty = true
  }

  /** Amount deposited at the centre line for a move at `speed`, scaled
   * to the frame's length. */
  const amountAt = (speed: number, dt: number): number => {
    const s = Math.min(Math.max(speed / Math.max(p.speed, 1), 0), 4)
    return p.strength * s ** Math.max(p.gamma, 0.01) * Math.min(dt * 60, 4)
  }

  const dispatch = (
    keep: number,
    a: [number, number],
    b: [number, number],
    amount: number
  ): void => {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy)
    step[STEP_AT.grid] = cols
    step[STEP_AT.grid + 1] = rows
    step[STEP_AT.cell] = cell
    step[STEP_AT.keep] = keep
    step[STEP_AT.a] = a[0]
    step[STEP_AT.a + 1] = a[1]
    step[STEP_AT.b] = b[0]
    step[STEP_AT.b + 1] = b[1]
    step[STEP_AT.dir] = len > 1e-3 ? dx / len : 0
    step[STEP_AT.dir + 1] = len > 1e-3 ? dy / len : 0
    step[STEP_AT.radius] = Math.max(1, p.radius)
    step[STEP_AT.amount] = amount
    device.queue.writeBuffer(stepBuf, 0, step)
    group ??= device.createBindGroup({
      label,
      layout,
      entries: bindEntries(stepLayout, {
        field: { buffer: field },
        st: { buffer: stepBuf }
      })
    })
    const enc = device.createCommandEncoder({ label })
    const cp = enc.beginComputePass({ label })
    cp.setPipeline(pipeline)
    cp.setBindGroup(0, group)
    cp.dispatchWorkgroups(Math.ceil(cols / 8), Math.ceil(rows / 8))
    cp.end()
    device.queue.submit([enc.finish()])
  }

  const handle: Trail = {
    name,
    params: p,
    schema,
    cell,
    get enabled() {
      return life.enabled
    },
    set enabled(on: boolean) {
      life.setEnabled(on)
    },
    pointer: o.pointer ?? true,
    get active() {
      return !life.destroyed && (energy > EPS || pending.length > 0)
    },
    stroke(a, b, speed) {
      if (life.destroyed) {
        return
      }
      pending.push({
        a: [a.x, a.y],
        b: [b.x, b.y],
        s: speed ?? p.speed,
        t: 1 / 60
      })
      deps.wake()
    },
    clear() {
      // Strokes queued for the next frame go too, or they'd refill it.
      pending = []
      if (!life.destroyed && cols > 0) {
        zero()
        deps.wake()
      }
    },
    destroy() {
      if (!life.destroy()) {
        return
      }
      life.enabled = false
      pending = []
      if (cols > 0) {
        zero()
      }
      writeInfo()
      onRemove(state)
      deps.wake()
    }
  }

  const state: TrailState = {
    handle,
    life,
    frame(ctx, ptr) {
      if (!life.enabled || life.destroyed) {
        return
      }
      fit(ctx.width, ctx.height)
      const dt = Math.min(Math.max(ctx.dt, 0), 1 / 15)
      const keep = Math.min(Math.max(p.decay, 0), 1) ** (dt * 60)
      const strokes = pending
      pending = []
      const cur: [number, number] = [ptr.x, ptr.y]
      const speed = Math.hypot(ptr.vx, ptr.vy)
      if (handle.pointer && ptr.seen && dt > 0) {
        const from: [number, number] = prev ? [prev.x, prev.y] : cur
        const moved = Math.hypot(cur[0] - from[0], cur[1] - from[1]) > 0.01
        if (moved || speed > 1) {
          strokes.push({ a: from, b: cur, s: speed, t: dt })
        }
      }
      prev = ptr.seen ? { x: cur[0], y: cur[1] } : null
      if (strokes.length === 0 && energy <= EPS) {
        if (!empty) {
          zero()
        }
        return
      }
      energy *= keep
      if (strokes.length === 0) {
        dispatch(keep, cur, cur, 0)
        return
      }
      // The first stroke carries the frame's fade; any others only add.
      strokes.forEach((s, i) => {
        const amount = amountAt(s.s, s.t)
        energy += amount
        dispatch(i === 0 ? keep : 1, s.a, s.b, amount)
      })
      empty = false
    },
    live: () => life.busy(),
    binding: () => ({ field, info, version }),
    free() {
      field.destroy()
      info.destroy()
      stepBuf.destroy()
    }
  }
  states.set(handle, state)
  ready = true
  if (life.enabled) {
    deps.wake()
  }
  return state
}
