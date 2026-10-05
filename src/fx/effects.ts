import type {
  PostChain,
  PostFrame,
  RegionFrame,
  RegionHandler,
  RenderGraph
} from '../gpu/graph'
import type { Compositor, FrameContext, PointerState } from '../types'
import { reportShaderErrors } from '../util/log'
import {
  createLayer,
  inertLayer,
  type Layer,
  type LayerOptions,
  type LayerState
} from './layer'
import {
  createParams,
  type ParamBlock,
  type ParamSchema,
  type ParamValues
} from './params'
import {
  applyOverride,
  emptyPointer,
  POINTER_BYTES,
  type PointerOverride,
  PointerTracker
} from './pointer'
import {
  EFFECT_BYTES,
  effectSource,
  type Fragment,
  stageSource
} from './shader'
import { createTarget, type Target } from './target'

export interface PassOptions<S extends ParamSchema = ParamSchema> {
  /** Labels pipelines and shader errors. */
  name: string
  /** WGSL defining `fn effect(uv, src, smp) -> vec4f`, a `tgpu.fn` of
   * that signature, or an array of them: each runs as its own stage, in
   * order, on the previous stage's output, sharing `params`. */
  fragment: Fragment | readonly Fragment[]
  params?: S
  /** CSS px the fragment samples beyond the viewport (a blur's reach), or
   * a function of the params. Default 0. */
  radius?: number | ((params: ParamValues<S>) => number)
  /** Default true. */
  enabled?: boolean
  /** Keep the frame loop running while enabled (time-based motion).
   * Default false. */
  continuous?: boolean
  /** Apply to this element only (a region pass): while enabled its
   * subtree renders to its own texture and the pass composites it, `uv`
   * spanning the element's border box. Not part of the fullscreen chain. */
  region?: Target | Element
}

export interface Pass<S extends ParamSchema = ParamSchema> {
  readonly name: string
  readonly params: ParamValues<S>
  /** Toggling requests a frame; enabling resets `elapsed`. */
  enabled: boolean
  continuous: boolean
  /** The declared sampling radius right now, CSS px. */
  readonly radius: number
  /** The element a region pass applies to; null for fullscreen. */
  readonly region: Target | null
  /** Remove the pass from the chain and free its GPU resources. */
  destroy(): void
}

/** Fixed inputs for deterministic captures (test harnesses only). */
export interface FxOverride {
  /** Page clock, s. */
  time?: number
  /** Every effect's elapsed, s. */
  elapsed?: number
  pointer?: PointerOverride
}

export interface Effects {
  /** False when the compositor is inert: calls work, nothing renders. */
  readonly active: boolean
  /** Live pointer state (`ease` is writable). */
  readonly pointer: PointerState
  pass<S extends ParamSchema>(opts: PassOptions<S>): Pass<S>
  /** Instanced quads drawn in paint order (see LayerOptions). */
  layer<S extends ParamSchema>(opts: LayerOptions<S>): Layer<S>
  /** The (cached) Target for `el`. */
  target(el: Element): Target
  /** Targets for every element matching `selector` (under `root`). */
  targets(selector: string, root?: ParentNode): Target[]
  /** Remove every pass and layer and the pointer listeners. */
  destroy(): void
  /** Test hook: pin time/elapsed/pointer (null clears). Requests a frame. */
  __override(o: FxOverride | null): void
}

interface Stage {
  pipeline: GPURenderPipeline
  /** Region passes' last stage: blended over the parent target. */
  over: GPURenderPipeline | null
  effect: GPUBuffer
  bindGroup: GPUBindGroup
}

/** A stage's input: its view, where its texel (0,0) sits in canvas device
 * px, the valid region's size and the texture's size. */
interface Source {
  view: GPUTextureView
  x: number
  y: number
  w: number
  h: number
  texW: number
  texH: number
}

interface PassState {
  name: string
  block: ParamBlock<ParamSchema>
  radius: () => number
  enabled: boolean
  continuous: boolean
  /** ctx.time (ms) of the first frame after enabling; null until then. */
  enabledAt: number | null
  paramsBuf: GPUBuffer | null
  stages: Stage[]
  /** Region passes: the element, and its ping-pong pair (multi-stage). */
  region: Target | null
  ping: GPUTexture[]
}

/** A Pass object over `s` (shared by the inert and GPU paths).
 * `toggled` runs after `enabled` changes. */
function passHandle<S extends ParamSchema>(
  s: PassState,
  wake: () => void,
  remove: () => void,
  toggled?: () => void
): Pass<S> {
  return {
    name: s.name,
    params: s.block.values as ParamValues<S>,
    get enabled() {
      return s.enabled
    },
    set enabled(on: boolean) {
      if (on === s.enabled) {
        return
      }
      s.enabled = on
      if (on) {
        s.enabledAt = null
      }
      toggled?.()
      wake()
    },
    get continuous() {
      return s.continuous
    },
    set continuous(on: boolean) {
      s.continuous = on
      wake()
    },
    get radius() {
      return s.radius()
    },
    region: s.region,
    destroy: remove
  }
}

function radiusFn<S extends ParamSchema>(
  opts: PassOptions<S>,
  values: ParamValues<S>
): () => number {
  const r = opts.radius
  if (typeof r === 'function') {
    return () => Math.max(0, r(values) || 0)
  }
  const n = Math.max(0, r ?? 0)
  return () => n
}

/** `el` as a Target (cached per element in `cache`). */
function targetOf(
  el: Target | Element,
  cache: WeakMap<Element, Target>,
  graph: RenderGraph | null
): Target {
  if (!(el instanceof Element)) {
    return el
  }
  let t = cache.get(el)
  if (!t) {
    t = createTarget(el, graph)
    cache.set(el, t)
  }
  return t
}

function inertEffects(): Effects {
  const pointer = emptyPointer()
  const cache = new WeakMap<Element, Target>()
  return {
    active: false,
    pointer,
    layer: (opts) => inertLayer(opts),
    target: (el) => targetOf(el, cache, null),
    targets: (sel, root = document) =>
      Array.from(root.querySelectorAll(sel), (el) => targetOf(el, cache, null)),
    pass<S extends ParamSchema>(opts: PassOptions<S>): Pass<S> {
      const block = createParams(opts.params ?? ({} as S), () => {})
      const s: PassState = {
        name: opts.name,
        block,
        radius: radiusFn(opts, block.values),
        enabled: opts.enabled ?? true,
        continuous: opts.continuous ?? false,
        enabledAt: null,
        paramsBuf: null,
        stages: [],
        region: opts.region ? targetOf(opts.region, cache, null) : null,
        ping: []
      }
      return passHandle<S>(
        s,
        () => {},
        () => {}
      )
    },
    destroy() {},
    __override() {}
  }
}

/** Ping-pong targets are sized up to this many device px, for reuse. */
const SIZE_STEP = 64

/**
 * Create the effects runtime for `compositor`. On an inert compositor
 * (no WebGPU, or server-side) it returns an inert runtime: every call
 * works and nothing renders.
 */
export function createEffects(compositor: Compositor): Effects {
  const graph: RenderGraph | null = compositor.active ? compositor.graph : null
  if (!graph) {
    return inertEffects()
  }
  const { device, format, frameLayout } = graph.shared
  const passes: PassState[] = []
  const layers: LayerState[] = []
  const targetCache = new WeakMap<Element, Target>()
  let override: FxOverride | null = null
  let destroyed = false

  const anyEnabled = (): boolean =>
    passes.some((p) => p.enabled) || layers.some((l) => l.enabled)
  const tracker = new PointerTracker(() => {
    if (anyEnabled()) {
      graph.requestFrame()
    }
  })
  tracker.listen()

  const srcLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' }
      }
    ]
  })
  const uniform = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    buffer: { type: 'uniform' }
  })
  const effectLayout = device.createBindGroupLayout({
    entries: [uniform(0), uniform(1), uniform(2)]
  })
  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [frameLayout, srcLayout, effectLayout]
  })
  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge'
  })
  const pointerBuf = device.createBuffer({
    label: 'fx-pointer',
    size: POINTER_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })

  // Ping-pong targets (the rect the chain writes) and bind group 1 per
  // source view.
  let ping: GPUTexture[] = []
  const srcGroups = new Map<GPUTextureView, GPUBindGroup>()
  const pingViews: GPUTextureView[] = []
  let lastScene: GPUTextureView | null = null
  const releaseTargets = (): void => {
    for (const t of ping) {
      t.destroy()
    }
    ping = []
    pingViews.length = 0
    srcGroups.clear()
    lastScene = null
  }
  const ensureTargets = (w: number, h: number): void => {
    const t = ping[0]
    if (t && t.width >= w && t.height >= h) {
      return
    }
    releaseTargets()
    const width = Math.ceil(w / SIZE_STEP) * SIZE_STEP
    const height = Math.ceil(h / SIZE_STEP) * SIZE_STEP
    for (let i = 0; i < 2; i++) {
      const tex = device.createTexture({
        label: `fx-ping-${i}`,
        size: { width, height },
        format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      })
      ping.push(tex)
      pingViews.push(tex.createView())
    }
  }
  const srcGroup = (view: GPUTextureView): GPUBindGroup => {
    let g = srcGroups.get(view)
    if (!g) {
      g = device.createBindGroup({
        layout: srcLayout,
        entries: [
          { binding: 0, resource: view },
          { binding: 1, resource: sampler }
        ]
      })
      srcGroups.set(view, g)
    }
    return g
  }

  // Per-frame state, set in beforeFrame.
  let pointerNow: PointerState = tracker.state
  let timeMs = 0
  const effectData = new Float32Array(EFFECT_BYTES / 4)
  /** This frame's running stages, in order (filled by encode). */
  const running: { pass: PassState; stage: Stage }[] = []

  /** In the fullscreen chain this frame (region passes never are). */
  const live = (p: PassState): boolean =>
    p.enabled && p.stages.length > 0 && !p.region

  const writeEffect = (
    p: PassState,
    stage: Stage,
    frame: PostFrame,
    src: Source,
    dst: { x: number; y: number }
  ): void => {
    const d = effectData
    const v = frame.viewport
    d[0] = override?.time ?? timeMs / 1000
    d[1] = override?.elapsed ?? (timeMs - (p.enabledAt ?? timeMs)) / 1000
    d[2] = v.width
    d[3] = v.height
    d[4] = 1 / Math.max(1, v.width)
    d[5] = 1 / Math.max(1, v.height)
    d[6] = frame.ctx.scrollX
    d[7] = frame.ctx.scrollY
    d[8] = frame.dpr
    d[9] = 0
    d[10] = v.x
    d[11] = v.y
    d[12] = src.x
    d[13] = src.y
    d[14] = src.w
    d[15] = src.h
    d[16] = dst.x
    d[17] = dst.y
    d[18] = 1 / src.texW
    d[19] = 1 / src.texH
    d[20] = frame.ctx.scrollX
    d[21] = frame.ctx.scrollY
    d[22] = 1
    d[23] = 0
    device.queue.writeBuffer(stage.effect, 0, d)
  }

  const chain: PostChain = {
    active: () => passes.some(live),
    radius() {
      let r = 0
      for (const p of passes) {
        if (live(p)) {
          r = Math.max(r, p.radius())
        }
      }
      return r
    },
    encode(frame) {
      running.length = 0
      for (const p of passes) {
        if (!live(p)) {
          continue
        }
        if (p.block.dirty && p.paramsBuf) {
          device.queue.writeBuffer(p.paramsBuf, 0, p.block.pack())
        }
        for (const stage of p.stages) {
          running.push({ pass: p, stage })
        }
      }
      if (frame.scene !== lastScene) {
        if (lastScene) {
          srcGroups.delete(lastScene)
        }
        lastScene = frame.scene
      }
      const r = frame.rect
      if (running.length > 1) {
        ensureTargets(r.width, r.height)
      }
      // Stage i reads the scene (i = 0) or ping[(i - 1) % 2] and writes
      // ping[i % 2]; the last stage writes the canvas in composite().
      for (let i = 0; i < running.length - 1; i++) {
        const run = running[i]
        const view = pingViews[i % 2]
        if (!run || !view) {
          continue
        }
        const src = sourceOf(i, frame)
        writeEffect(run.pass, run.stage, frame, src, { x: r.x, y: r.y })
        const rp = frame.encoder.beginRenderPass({
          label: `fx:${run.pass.name}`,
          colorAttachments: [
            {
              view,
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store'
            }
          ]
        })
        rp.setBindGroup(0, graph.shared.frameBindGroup)
        rp.setScissorRect(0, 0, r.width, r.height)
        draw(rp, run.stage, src.view)
        rp.end()
      }
    },
    composite(rp, frame) {
      const i = running.length - 1
      const run = running[i]
      if (!run) {
        return
      }
      const src = sourceOf(i, frame)
      writeEffect(run.pass, run.stage, frame, src, { x: 0, y: 0 })
      draw(rp, run.stage, src.view)
    }
  }

  const sourceOf = (i: number, frame: PostFrame): Source => {
    const view = i > 0 ? pingViews[(i - 1) % 2] : undefined
    const t = ping[0]
    if (!view || !t) {
      const w = frame.sceneWidth
      const h = frame.sceneHeight
      return { view: frame.scene, x: 0, y: 0, w, h, texW: w, texH: h }
    }
    const r = frame.rect
    return {
      view,
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
      texW: t.width,
      texH: t.height
    }
  }

  const draw = (
    rp: GPURenderPassEncoder,
    stage: Stage,
    src: GPUTextureView
  ): void => {
    rp.setPipeline(stage.pipeline)
    rp.setBindGroup(1, srcGroup(src))
    rp.setBindGroup(2, stage.bindGroup)
    rp.draw(3)
  }

  const removeHook = graph.addHook({
    beforeFrame(ctx: FrameContext) {
      timeMs = ctx.time
      tracker.step(ctx.dt, ctx.scrollX, ctx.scrollY)
      const o = override?.pointer
      pointerNow = o
        ? applyOverride(tracker.state, o, ctx.scrollX, ctx.scrollY)
        : tracker.state
      ctx.pointer = pointerNow
      let chainLive = false
      let any = false
      for (const p of passes) {
        if (p.enabled) {
          any = true
          chainLive ||= !p.region
          p.enabledAt ??= ctx.time
        }
        if (!p.enabled && p.ping.length > 0) {
          freePing(p)
        }
      }
      for (const l of layers) {
        any ||= l.enabled
        l.frame(ctx)
      }
      if (any) {
        device.queue.writeBuffer(pointerBuf, 0, tracker.pack(pointerNow))
      }
      // Leaving the offscreen path: free the ping-pong targets.
      if (!chainLive && ping.length > 0) {
        releaseTargets()
      }
    },
    keepAlive() {
      let any = false
      for (const e of [...passes, ...layers]) {
        if (e.enabled) {
          if (e.continuous) {
            return true
          }
          any = true
        }
      }
      return any && !override?.pointer && tracker.moving()
    }
  })
  graph.setPostChain(chain)

  const buildStage = (
    name: string,
    fragment: Fragment,
    block: ParamBlock<ParamSchema>,
    paramsBuf: GPUBuffer,
    index: number,
    over: boolean
  ): Stage => {
    const label = index > 0 ? `fx:${name}#${index}` : `fx:${name}`
    const code = stageSource(effectSource(fragment, name), block.wgsl)
    const module = device.createShaderModule({ label, code })
    reportShaderErrors(module, label)
    const pipeline = device.createRenderPipeline({
      label,
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'fx_vs' },
      fragment: { module, entryPoint: 'fx_fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }
    })
    const blend: GPUBlendComponent = {
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add'
    }
    const overPipeline = over
      ? device.createRenderPipeline({
          label: `${label}:over`,
          layout: pipelineLayout,
          vertex: { module, entryPoint: 'fx_vs' },
          fragment: {
            module,
            entryPoint: 'fx_fs_over',
            targets: [{ format, blend: { color: blend, alpha: blend } }]
          },
          primitive: { topology: 'triangle-list' }
        })
      : null
    const effect = device.createBuffer({
      label: `${label}:effect`,
      size: EFFECT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    const bindGroup = device.createBindGroup({
      layout: effectLayout,
      entries: [
        { binding: 0, resource: { buffer: effect } },
        { binding: 1, resource: { buffer: paramsBuf } },
        { binding: 2, resource: { buffer: pointerBuf } }
      ]
    })
    return { pipeline, over: overPipeline, effect, bindGroup }
  }

  const freePing = (s: PassState): void => {
    for (const t of s.ping) {
      t.destroy()
    }
    s.ping = []
  }
  const freePass = (s: PassState): void => {
    freePing(s)
    for (const st of s.stages) {
      st.effect.destroy()
    }
    s.stages = []
    s.paramsBuf?.destroy()
    s.paramsBuf = null
  }

  // Region passes: the renderer hands over the element's group texture
  // when the group closes (gpu/graph.ts RegionHandler). Coordinates are the
  // parent target's device px; `uv` spans the element's border box.
  const regionSrc = new WeakMap<GPUTextureView, GPUBindGroup>()
  const regionSrcGroup = (view: GPUTextureView): GPUBindGroup => {
    let g = regionSrc.get(view)
    if (!g) {
      g = device.createBindGroup({
        layout: srcLayout,
        entries: [
          { binding: 0, resource: view },
          { binding: 1, resource: sampler }
        ]
      })
      regionSrc.set(view, g)
    }
    return g
  }
  const views = new WeakMap<GPUTexture, GPUTextureView>()
  const viewOf = (t: GPUTexture): GPUTextureView => {
    let v = views.get(t)
    if (!v) {
      v = t.createView()
      views.set(t, v)
    }
    return v
  }
  const regionPing = (p: PassState, w: number, h: number): void => {
    const t = p.ping[0]
    if (t && t.width >= w && t.height >= h) {
      return
    }
    freePing(p)
    const width = Math.ceil(w / SIZE_STEP) * SIZE_STEP
    const height = Math.ceil(h / SIZE_STEP) * SIZE_STEP
    for (let i = 0; i < 2; i++) {
      p.ping.push(
        device.createTexture({
          label: `fx:${p.name}:ping-${i}`,
          size: { width, height },
          format,
          usage:
            GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
        })
      )
    }
  }
  const writeRegion = (
    p: PassState,
    stage: Stage,
    f: RegionFrame,
    src: Source,
    dst: { x: number; y: number },
    alpha: number
  ): void => {
    const t = p.region
    const r = t?.rect
    const s = f.scale
    // The element's border box in the parent's device px (the group's
    // rect when it has no size).
    let bx = f.x
    let by = f.y
    let bw = f.width
    let bh = f.height
    let docX = f.parentX + f.x / s
    let docY = f.parentY + f.y / s
    if (t && r && r.width > 0 && r.height > 0) {
      docX = r.x + (t.space === 'viewport' ? f.ctx.scrollX : 0)
      docY = r.y + (t.space === 'viewport' ? f.ctx.scrollY : 0)
      bx = (docX - f.parentX) * s
      by = (docY - f.parentY) * s
      bw = r.width * s
      bh = r.height * s
    }
    const d = effectData
    d[0] = override?.time ?? timeMs / 1000
    d[1] = override?.elapsed ?? (timeMs - (p.enabledAt ?? timeMs)) / 1000
    d[2] = bw
    d[3] = bh
    d[4] = 1 / Math.max(1, bw)
    d[5] = 1 / Math.max(1, bh)
    d[6] = docX
    d[7] = docY
    d[8] = s
    d[9] = 0
    d[10] = bx
    d[11] = by
    d[12] = src.x
    d[13] = src.y
    d[14] = src.w
    d[15] = src.h
    d[16] = dst.x
    d[17] = dst.y
    d[18] = 1 / src.texW
    d[19] = 1 / src.texH
    d[20] = f.ctx.scrollX
    d[21] = f.ctx.scrollY
    d[22] = alpha
    d[23] = 0
    device.queue.writeBuffer(stage.effect, 0, d)
  }
  const regionSource = (p: PassState, i: number, f: RegionFrame): Source => {
    const view = i > 0 ? p.ping[(i - 1) % 2] : undefined
    if (!view) {
      return {
        view: f.source,
        x: f.x,
        y: f.y,
        w: f.width,
        h: f.height,
        texW: f.sourceWidth,
        texH: f.sourceHeight
      }
    }
    return {
      view: viewOf(view),
      x: f.x,
      y: f.y,
      w: f.width,
      h: f.height,
      texW: view.width,
      texH: view.height
    }
  }
  const regionHandler = (p: PassState): RegionHandler => ({
    pad: () => p.radius(),
    active: () => p.enabled && p.stages.length > 0 && !destroyed,
    encode(f) {
      if (p.block.dirty && p.paramsBuf) {
        device.queue.writeBuffer(p.paramsBuf, 0, p.block.pack())
      }
      const n = p.stages.length
      if (n > 1) {
        regionPing(p, f.width, f.height)
      }
      for (let i = 0; i < n - 1; i++) {
        const stage = p.stages[i]
        const out = p.ping[i % 2]
        if (!stage || !out) {
          continue
        }
        const src = regionSource(p, i, f)
        writeRegion(p, stage, f, src, { x: f.x, y: f.y }, 1)
        const rp = f.encoder.beginRenderPass({
          label: `fx:${p.name}`,
          colorAttachments: [
            {
              view: viewOf(out),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store'
            }
          ]
        })
        rp.setBindGroup(0, graph.shared.frameBindGroup)
        rp.setScissorRect(0, 0, f.width, f.height)
        rp.setPipeline(stage.pipeline)
        rp.setBindGroup(1, regionSrcGroup(src.view))
        rp.setBindGroup(2, stage.bindGroup)
        rp.draw(3)
        rp.end()
      }
    },
    composite(rp, f) {
      const i = p.stages.length - 1
      const stage = p.stages[i]
      if (!stage?.over) {
        return
      }
      const src = regionSource(p, i, f)
      writeRegion(p, stage, f, src, { x: 0, y: 0 }, f.alpha)
      rp.setPipeline(stage.over)
      rp.setBindGroup(1, regionSrcGroup(src.view))
      rp.setBindGroup(2, stage.bindGroup)
      rp.draw(3)
    }
  })

  const layerDeps = {
    device,
    format,
    frameLayout,
    graph,
    pointerBuf,
    time: () => override?.time ?? timeMs / 1000,
    elapsedOverride: () => override?.elapsed ?? null,
    wake: () => graph.requestFrame()
  }

  return {
    active: true,
    get pointer() {
      return tracker.state
    },
    pass<S extends ParamSchema>(opts: PassOptions<S>): Pass<S> {
      // The write hook only runs after `state` exists.
      const block = createParams(opts.params ?? ({} as S), () => {
        if (state.enabled) {
          graph.requestFrame()
        }
      })
      const generic = block as unknown as ParamBlock<ParamSchema>
      const state: PassState = {
        name: opts.name,
        block: generic,
        radius: radiusFn(opts, block.values),
        enabled: opts.enabled ?? true,
        continuous: opts.continuous ?? false,
        enabledAt: null,
        paramsBuf: null,
        stages: [],
        region: opts.region ? targetOf(opts.region, targetCache, graph) : null,
        ping: []
      }
      const handler = state.region ? regionHandler(state) : null
      const isolate = (): void => {
        const el = state.region?.el
        if (el && handler) {
          graph.isolate(el, state.enabled && !destroyed ? handler : null)
        }
      }
      if (!destroyed) {
        const paramsBuf = device.createBuffer({
          label: `fx:${opts.name}:params`,
          size: block.byteSize,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        })
        device.queue.writeBuffer(paramsBuf, 0, block.pack())
        state.paramsBuf = paramsBuf
        const frags = Array.isArray(opts.fragment)
          ? (opts.fragment as readonly Fragment[])
          : [opts.fragment as Fragment]
        state.stages = frags.map((f, i) =>
          buildStage(
            opts.name,
            f,
            generic,
            paramsBuf,
            i,
            handler !== null && i === frags.length - 1
          )
        )
        passes.push(state)
        isolate()
        if (state.enabled) {
          graph.requestFrame()
        }
      }
      return passHandle<S>(
        state,
        () => graph.requestFrame(),
        () => {
          const i = passes.indexOf(state)
          if (i === -1) {
            return
          }
          passes.splice(i, 1)
          freePass(state)
          state.enabled = false
          isolate()
          if (passes.length === 0) {
            releaseTargets()
          }
          graph.requestFrame()
        },
        isolate
      )
    },
    layer<S extends ParamSchema>(opts: LayerOptions<S>): Layer<S> {
      if (destroyed) {
        return inertLayer(opts)
      }
      const s = createLayer(opts, layerDeps, (st) => {
        const i = layers.indexOf(st)
        if (i !== -1) {
          layers.splice(i, 1)
        }
        graph.requestFrame()
      })
      layers.push(s)
      return s.handle as unknown as Layer<S>
    },
    target: (el) => targetOf(el, targetCache, graph),
    targets: (sel, root = document) =>
      Array.from(root.querySelectorAll(sel), (el) =>
        targetOf(el, targetCache, graph)
      ),
    destroy() {
      if (destroyed) {
        return
      }
      destroyed = true
      tracker.unlisten()
      removeHook()
      graph.setPostChain(null)
      for (const p of passes) {
        freePass(p)
        p.enabled = false
        if (p.region) {
          graph.isolate(p.region.el, null)
        }
      }
      passes.length = 0
      for (const l of [...layers]) {
        l.handle.destroy()
      }
      layers.length = 0
      releaseTargets()
      pointerBuf.destroy()
    },
    __override(o) {
      override = o
      graph.requestFrame()
    }
  }
}
