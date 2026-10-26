import type { MaterialEntry, RenderGraph } from '../gpu/graph'
import type { MaterialKind } from '../gpu/material'
import type { FrameContext } from '../types'
import type { EffectsClock } from './clock'
import { type Hook, hookSource, MATERIAL_HOOKS } from './gpu'
import { Lifecycle } from './lifecycle'
import {
  createParams,
  type ParamBlock,
  type ParamSchema,
  type ParamValues
} from './params'
import { POINTER_WGSL } from './pointer'
import { readsTime } from './shader'
import type { Target } from './target'
import { type Trail, trailState, trailWgsl } from './trail'
import { guarded } from '../util/log'

// Materials: re-shade a Target's mirrored records with author hooks
// (docs/EFFECTS.md "Material"). The record passes compile a variant of
// their own shader around the hooks (gpu/material.ts), so anti-aliasing,
// clipping, blending and paint order stay theirs. Contract:
// src/fx/README.md.

/** Bytes in the MaterialFx uniform (see UNIFORMS_WGSL). */
export const MATERIAL_FX_BYTES = 32

const UNIFORMS_WGSL = /* wgsl */ `
struct MaterialFx {
  time     : f32,    // page clock, s
  elapsed  : f32,    // s since this material was last enabled
  dpr      : f32,
  glyphs   : f32,    // glyphs mat_index numbers (glyph materials)
  scroll   : vec2f,  // the real document scroll, CSS px
  viewport : vec2f,  // visible viewport, CSS px
};
@group(2) @binding(0) var<uniform> fx : MaterialFx;
@group(2) @binding(1) var<uniform> params : Params;
@group(2) @binding(2) var<uniform> pointer : Pointer;
`

// With `trail`: the field (bindings 3 and 4) and trail_page(p).
const TRAIL_WGSL = /* wgsl */ `
${trailWgsl(2, 3)}
// The trail at p, page CSS px (MatIn.page outside fixed subtrees).
fn trail_page(p : vec2f) -> vec4f {
  return trail_at(p - fx.scroll);
}
`

const IDENTITY_VERTEX = /* wgsl */ `
fn vertex(local : vec2f, size : vec2f, uv : vec2f, record : u32) -> vec2f {
  return local;
}
`

const IDENTITY_FRAGMENT = /* wgsl */ `
fn fragment(m : MatIn) -> vec4f {
  return m.color;
}
`

const HOOKS_WGSL = /* wgsl */ `
fn mat_vertex(local : vec2f, size : vec2f, uv : vec2f, record : u32) -> vec2f {
  return vertex(local, size, uv, record);
}
fn mat_fragment(m : MatIn) -> vec4f {
  return fragment(m);
}
`

export interface MaterialOptions<S extends ParamSchema = ParamSchema> {
  /** Labels pipelines and shader errors. */
  name: string
  /** The element whose subtree is re-shaded. */
  target: Target | Element
  /** Record kinds to re-shade. Default all three, or the keys of `raw`. */
  kinds?: readonly MaterialKind[]
  /** WGSL defining `fn vertex(local : vec2f, size : vec2f, uv : vec2f,
   * record : u32) -> vec2f`: the displaced local position. */
  vertex?: Hook
  /** WGSL defining `fn fragment(m : MatIn) -> vec4f` (premultiplied). */
  fragment?: Hook
  /** Complete programs per record kind, for what the hooks can't
   * express: WGSL defining `@vertex fn vs(@builtin(vertex_index) vi :
   * u32, @builtin(instance_index) ii : u32) -> VOut` and `@fragment fn
   * fs(in : VOut) -> @location(0) vec4f`, compiled after the pass's own
   * declarations (its instance struct and bindings, `VOut`, and its
   * entry points as `default_vs(vi, ii)` / `default_fs(in)`, which run
   * the hooks). Bind group 2 is the material's, as for hooks. */
  raw?: Partial<Record<MaterialKind, string>>
  params?: S
  /** Cells per side each record's quad is split into, so a vertex hook
   * can bend it. Default 1. */
  subdivisions?: number
  /** Default true. */
  enabled?: boolean
  /** Keep the frame loop running while enabled. Default: true when a
   * hook or raw program reads `fx.time`/`fx.elapsed`. */
  continuous?: boolean
  /** Hide the target's own DOM paint while enabled (displaced geometry
   * would uncover it). Default: true when `vertex` or `raw` is given. */
  hideSource?: boolean
  /** Until its pipeline for a record kind has compiled, don't draw those
   * records (default: they draw as usual). For materials that start
   * hidden, such as a reveal. */
  hold?: boolean
  /** Called every frame while enabled. `time` is the page clock, s. */
  update?: (material: Material<S>, time: number, ctx: FrameContext) => void
  /** Read this trail's field in the hooks: `trail_at(p)` (viewport CSS
   * px), `trail_page(p)`, `trail_cell(p)`, `trail_snap(p)`. */
  trail?: Trail
}

export interface Material<S extends ParamSchema = ParamSchema> {
  readonly name: string
  readonly params: ParamValues<S>
  /** The params' schema (see ParamBlock.schema). */
  readonly schema: S
  readonly target: Target
  enabled: boolean
  continuous: boolean
  /** Compile the pipelines now instead of when its records are first
   * drawn enabled, so a material created disabled is ready when it turns
   * on. Materials with the same hooks share pipelines, so warming one
   * warms its copies. The replace-mode handoff waits for compiles in
   * flight: warm after `compositor.ready` to keep it out of the way. */
  warm(): void
  destroy(): void
}

/** What a Material needs from the runtime (effects.ts). */
export interface MaterialDeps {
  device: GPUDevice
  graph: RenderGraph
  pointerBuf: GPUBuffer
  clock: EffectsClock
  /** The pointer uniform differs from the previous frame's. */
  pointerMoved(): boolean
  wake(): void
}

/** Runtime-side state of a Material (effects.ts drives it). */
export interface MaterialState {
  handle: Material<ParamSchema>
  life: Lifecycle
  frame(ctx: FrameContext): void
  destroy(): void
}

const ALL_KINDS: readonly MaterialKind[] = ['box', 'image', 'glyph']

/** `continuous` unless given: whether `hooks` (the resolved hook WGSL)
 * or a raw program reads the clock. */
const materialContinuous = (o: MaterialOptions, hooks?: string): boolean =>
  o.continuous ??
  readsTime(hooks ?? o.vertex, o.fragment, ...Object.values(o.raw ?? {}))

const kindsOf = (o: MaterialOptions): readonly MaterialKind[] =>
  o.kinds ?? (o.raw ? (Object.keys(o.raw) as MaterialKind[]) : ALL_KINDS)

/** The material's hook WGSL (tgpu.fn hooks resolved; no device
 * needed), identity hooks for those it leaves out. */
const materialHooks = (o: MaterialOptions): string =>
  hookSource(o.name, [
    [o.vertex ?? IDENTITY_VERTEX, MATERIAL_HOOKS.vertex],
    [o.fragment ?? IDENTITY_FRAGMENT, MATERIAL_HOOKS.fragment]
  ]) ?? `${IDENTITY_VERTEX}\n${IDENTITY_FRAGMENT}`

/** A Material with no GPU side (inert runtime). */
export function inertMaterial<S extends ParamSchema>(
  o: MaterialOptions<S>,
  target: Target
): Material<S> {
  const block = createParams(o.params ?? ({} as S), () => {})
  const opts = o as unknown as MaterialOptions
  const life = new Lifecycle({
    enabled: o.enabled ?? true,
    continuous: materialContinuous(opts, materialHooks(opts)),
    timed: true,
    wake: () => {}
  })
  return {
    name: o.name,
    params: block.values as ParamValues<S>,
    schema: block.schema,
    target,
    get enabled() {
      return life.enabled
    },
    set enabled(on: boolean) {
      life.setEnabled(on)
    },
    get continuous() {
      return life.continuous
    },
    set continuous(on: boolean) {
      life.setContinuous(on)
    },
    warm() {},
    destroy() {
      life.destroy()
    }
  }
}

export function createMaterial<S extends ParamSchema>(
  o: MaterialOptions<S>,
  target: Target,
  deps: MaterialDeps,
  onRemove: (s: MaterialState) => void
): MaterialState {
  const { device, graph } = deps
  const id = graph.nextMaterialId()
  const label = `fx:${o.name}`
  const hides = o.hideSource ?? (o.vertex !== undefined || o.raw !== undefined)
  const hooks = materialHooks(o as unknown as MaterialOptions)
  const life = new Lifecycle({
    enabled: o.enabled ?? true,
    continuous: materialContinuous(o as unknown as MaterialOptions, hooks),
    timed: true,
    wake: deps.wake,
    toggled: (on) => {
      if (on) {
        fresh = true
      }
      apply()
    }
  })

  const block = createParams(o.params ?? ({} as S), () =>
    life.paramsChanged()
  ) as unknown as ParamBlock<ParamSchema>
  const trail = trailState(o.trail)
  // entry.changed's inputs (see frame()).
  const usesPointer = [hooks, ...Object.values(o.raw ?? {})].some(
    (c) => typeof c === 'string' && /\bpointer\s*\./.test(c)
  )
  let changedNow = true
  let fresh = true
  let trailWasLive = false
  const lastFx: number[] = []
  const code = [
    block.wgsl,
    POINTER_WGSL,
    UNIFORMS_WGSL,
    trail ? TRAIL_WGSL : '',
    hooks,
    HOOKS_WGSL
  ].join('\n')
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
  const layout = device.createBindGroupLayout({
    label,
    entries: [
      ...[0, 1, 2].map(
        (binding): GPUBindGroupLayoutEntry => ({
          binding,
          visibility: VF,
          buffer: { type: 'uniform' }
        })
      ),
      ...(trail
        ? [
            {
              binding: 3,
              visibility: VF,
              buffer: { type: 'read-only-storage' as const }
            },
            { binding: 4, visibility: VF, buffer: { type: 'uniform' as const } }
          ]
        : [])
    ]
  })
  const fxBuf = device.createBuffer({
    label: `${label}:fx`,
    size: MATERIAL_FX_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  const paramsBuf = device.createBuffer({
    label: `${label}:params`,
    size: block.byteSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  device.queue.writeBuffer(paramsBuf, 0, block.pack())
  /** Group 2; rebuilt (frame()) when the trail's field is replaced. */
  let bound = -1
  const makeGroup = (): GPUBindGroup => {
    const t = trail?.binding()
    bound = t?.version ?? -1
    return device.createBindGroup({
      label,
      layout,
      entries: [
        { binding: 0, resource: { buffer: fxBuf } },
        { binding: 1, resource: { buffer: paramsBuf } },
        { binding: 2, resource: { buffer: deps.pointerBuf } },
        ...(t
          ? [
              { binding: 3, resource: { buffer: t.field } },
              { binding: 4, resource: { buffer: t.info } }
            ]
          : [])
      ]
    })
  }
  const bindGroup = makeGroup()
  const fxData = new Float32Array(MATERIAL_FX_BYTES / 4)

  const entry: MaterialEntry & { bindGroup: GPUBindGroup } = {
    id,
    label,
    code,
    kinds: new Set(kindsOf(o as unknown as MaterialOptions)),
    ...(o.raw ? { raw: o.raw } : {}),
    subdivisions: Math.max(1, Math.floor(o.subdivisions ?? 1)),
    ...(o.hold ? { hold: true } : {}),
    layout,
    bindGroup,
    target: target.el,
    active: () => life.enabled && !life.destroyed,
    changed: () => changedNow,
    // A pipeline finished compiling: draw with it.
    ready: () => {
      if (life.enabled) {
        deps.wake()
      }
    }
  }

  const apply = (): void => {
    if (hides) {
      graph.hideSource(target.el, life.enabled && !life.destroyed)
    }
    graph.replace()
  }

  const handle: Material<ParamSchema> = {
    name: o.name,
    params: block.values,
    schema: block.schema,
    target,
    get enabled() {
      return life.enabled
    },
    set enabled(on: boolean) {
      life.setEnabled(on)
    },
    get continuous() {
      return life.continuous
    },
    set continuous(on: boolean) {
      life.setContinuous(on)
    },
    warm() {
      if (!life.destroyed) {
        graph.warmMaterial(entry)
      }
    },
    destroy() {
      if (life.destroy()) {
        onRemove(state)
        state.destroy()
      }
    }
  }

  const state: MaterialState = {
    handle,
    life,
    frame(ctx) {
      if (!life.enabled) {
        return
      }
      // Whether this frame's draw can differ from the last one's
      // (entry.changed: the renderer reuses an unchanged scene).
      const trailLive = trail?.live() ?? false
      let changed =
        fresh ||
        (life.continuous && !deps.clock.held()) ||
        o.update !== undefined ||
        block.dirty ||
        trailLive ||
        trailWasLive ||
        (usesPointer && deps.pointerMoved())
      fresh = false
      trailWasLive = trailLive
      if (trail && trail.binding().version !== bound) {
        entry.bindGroup = makeGroup()
        changed = true
      }
      life.start(deps.clock)
      const time = deps.clock.time()
      const update = o.update
      if (update) {
        life.inside(() =>
          guarded(`fx:${o.name} update`, () =>
            update(handle as unknown as Material<S>, time, ctx)
          )
        )
      }
      if (block.dirty) {
        device.queue.writeBuffer(paramsBuf, 0, block.pack())
      }
      const f = fxData
      f[0] = time
      f[1] = life.elapsed(deps.clock)
      f[2] = graph.shared.dpr
      f[3] = entry.glyphs ?? 0
      f[4] = ctx.scrollX
      f[5] = ctx.scrollY
      f[6] = ctx.width
      f[7] = ctx.height
      // dpr, glyph count, scroll and viewport (time is covered by
      // `continuous`).
      for (let i = 2; i < 8; i++) {
        if (f[i] !== lastFx[i]) {
          changed = true
          lastFx[i] = f[i] ?? 0
        }
      }
      changedNow = changed
      device.queue.writeBuffer(fxBuf, 0, f)
    },
    destroy() {
      removeEntry()
      if (hides) {
        graph.hideSource(target.el, false)
      }
      fxBuf.destroy()
      paramsBuf.destroy()
    }
  }
  const removeEntry = graph.addMaterial(entry)
  if (hides && life.enabled) {
    graph.hideSource(target.el, true)
  }
  if (life.enabled) {
    deps.wake()
  }
  return state
}
