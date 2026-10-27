import type { ElNode } from '../dom/tree'
import type {
  PostChain,
  PostFrame,
  RegionFrame,
  RegionHandler,
  RenderGraph
} from '../gpu/graph'
import { materialPipelinesSettled } from '../gpu/material'
import { timed } from '../gpu/timer'
import type { GlyphGhost } from '../text/slug/rasterizer'
import type { Compositor, FrameContext, PointerState } from '../types'
import { reportShaderErrors } from '../util/log'
import { EffectsClock } from './clock'
import { createComposer } from './compose'
import {
  createLayer,
  inertLayer,
  type Layer,
  type LayerOptions,
  type LayerState
} from './layer'
import { anyEnabled, keepAlive, Lifecycle } from './lifecycle'
import {
  createMaterial,
  inertMaterial,
  type Material,
  type MaterialOptions,
  type MaterialState
} from './material'
import { createMotion, type Motion, type MotionOptions } from './motion'
import {
  createParams,
  type ParamBlock,
  type ParamSchema,
  type ParamValues
} from './params'
import { type PathShape, pathShapesOf } from './path_shapes'
import {
  applyOverride,
  emptyPointer,
  POINTER_BYTES,
  type PointerOverride,
  PointerTracker
} from './pointer'
import { createReducedMotion } from './reduced_motion'
import { type FieldSource, type Sdf, SdfField, type SdfOptions } from './sdf'
import { MaskField } from './sdf_mask'
import {
  EFFECT_BYTES,
  effectSource,
  type Fragment,
  FX_IMAGE_BYTES,
  readsTime,
  stageSource
} from './shader'
import { createTarget, type Target, targetRuns } from './target'
import {
  inertTexture,
  type Texture,
  TextureBinding,
  type TextureInputs,
  TextureStore,
  textureLayoutEntries,
  textureList,
  texturesWgsl
} from './textures'
import {
  createTrail,
  inertTrail,
  type Trail,
  type TrailOptions,
  type TrailState,
  trailState
} from './trail'
import {
  createTransform,
  type Transform,
  type TransformOptions
} from './transform'
import {
  SNAPSHOT,
  Snapshot,
  type Transition,
  type TransitionOptions,
  transitionHandle
} from './transition'

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
  /** Run every stage but the last at 1/n resolution (each axis), the last
   * upsampling as it writes full resolution: for low-frequency passes
   * such as wide blurs. A number, or a function of the params and dpr
   * (re-evaluated each frame); 1 (default) keeps full resolution, up to
   * 4. Fullscreen passes only. */
  downsample?: number | ((params: ParamValues<S>, dpr: number) => number)
  /** Default true. */
  enabled?: boolean
  /** Keep the frame loop running while enabled (time-based motion).
   * Default false. */
  continuous?: boolean
  /** Apply to this element only (a region pass): while enabled its
   * subtree renders to its own texture and the pass composites it, `uv`
   * spanning the element's border box. Not part of the fullscreen chain. */
  region?: Target | Element
  /** Sample this element's image record in the fragment: `image(uv)`,
   * `image_level(uv, lod)` (premultiplied), `image_size()`. */
  image?: Target | Element
  /** Read this distance field in the fragment: `sdf(p)` (signed
   * distance from page point p, CSS px, to its element's rendered shape;
   * `uv_to_page(uv)` gives p), `sdf_ready()`. Not with `image` or on a
   * transition. */
  sdf?: Sdf
  /** Read this trail's field in the fragment: `trail(uv)`,
   * `trail_at(p)`, `trail_cell(p)`, `trail_snap(p)` (see Trail). */
  trail?: Trail
  /** Baked textures to read, by WGSL name (Effects.texture; at most 4):
   * `tex_<name>(uv)`, `tex_<name>_level(uv, lod)`, `tex_<name>_size()`,
   * `tex_<name>_ready()`. */
  textures?: TextureInputs
}

export interface Pass<S extends ParamSchema = ParamSchema> {
  readonly name: string
  readonly params: ParamValues<S>
  /** The params' schema (see ParamBlock.schema). */
  readonly schema: S
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
  /** Every layer's `fx.dt`, s (simulate steps). */
  dt?: number
  pointer?: PointerOverride
}

export interface Effects {
  /** False when the compositor is inert: calls work, nothing renders. */
  readonly active: boolean
  /** Live pointer state (`ease` is writable). */
  readonly pointer: PointerState
  pass<S extends ParamSchema>(opts: PassOptions<S>): Pass<S>
  /** A fullscreen pass that blends a held snapshot of the outgoing page
   * (`prev(uv)`) with the incoming one (see TransitionOptions). */
  transition<S extends ParamSchema>(opts: TransitionOptions<S>): Transition<S>
  /** Instanced quads drawn in paint order (see LayerOptions). */
  layer<S extends ParamSchema>(opts: LayerOptions<S>): Layer<S>
  /** Re-shade a target's mirrored records (see MaterialOptions). */
  material<S extends ParamSchema>(opts: MaterialOptions<S>): Material<S>
  /** The (cached) Target for `el`. */
  target(el: Element): Target
  /** Targets for every element matching `selector` (under `root`). */
  targets(selector: string, root?: ParentNode): Target[]
  /** A copy of `el`'s Slug glyphs as last drawn (the same set and order
   * as its Target's `glyphs`), their outline bands held resident until
   * `release()`: the outgoing text of a morph (presets/morph.ts). Null
   * without WebGPU or before the element's text has been drawn. */
  glyphGhost(el: Target | Element): GlyphGhost | null
  /** `el`'s vector svg shapes as last read (the path pass's records of
   * its subtree, in paint order) as plain data in viewport CSS px: what a
   * morph interpolates (presets/layout_morph.ts). Empty without WebGPU,
   * before the first read, or for an svg not drawn as vectors. */
  pathShapes(el: Target | Element): PathShape[]
  /** Move, scale, rotate and fade an element on the GPU (see
   * TransformOptions). Nothing without WebGPU. */
  transform(el: Target | Element, opts?: TransformOptions): Transform
  /** An element's layer transform from `from` to `to` as `progress` goes
   * 0 -> 1 (see MotionOptions). Nothing renders without WebGPU. */
  motion(el: Target | Element, opts?: MotionOptions): Motion
  /** A field of the pointer's recent motion, faded and deposited on the
   * GPU each frame, for passes, materials and layers to read (see
   * TrailOptions). */
  trail(opts?: TrailOptions): Trail
  /** A distance field of `el`'s rendered shape for passes and layers
   * (their `sdf` option), rebuilt when its content or box changes (see
   * SdfOptions). `el` is isolated while the field lives (not with a
   * region pass on the same element). */
  sdf(el: Target | Element, opts?: SdfOptions): Sdf
  /** A baked effect-input texture by its name in the assets manifest
   * (`textures` in the bake config; CompositorOptions.assets), for the
   * `textures` option of passes, layers and materials. It loads when an
   * effect first uses it. */
  texture(name: string): Texture
  /** Give up this caller's use of the runtime (createEffects returns the
   * same runtime per compositor, counting callers): the last release
   * destroys it. Destroy your own passes, motions etc. first. */
  release(): void
  /** Remove every pass, layer, material, transform and motion and the
   * pointer listeners, for every caller. Prefer release(). */
  destroy(): void
  /** The viewer asked for reduced motion (`prefers-reduced-motion:
   * reduce`, live), or setReducedMotion's override. While on, the effects clock holds still: `fx.time` and
   * `fx.elapsed` stop advancing, so time-driven effects (displace's
   * drift, ripples, custom hooks) stop moving, and Motion.play()/
   * reverse() jump to their end. Progress and params set by the page
   * (GSAP, Motion) still apply: gate those with the same media query. */
  readonly reducedMotion: boolean
  /** Override reducedMotion (true/false), or follow the system again
   * (null). */
  setReducedMotion(on: boolean | null): void
  /** Called with the new value whenever reducedMotion changes. Returns
   * the unsubscribe. */
  onReducedMotion(cb: (on: boolean) => void): () => void
  /** Test hook: pin time/elapsed/pointer (null clears). Requests a frame. */
  __override(o: FxOverride | null): void
  /** Test hook: material pipelines still compiling. */
  __pending(): number
  /** Test hook: material pipeline compiles finished so far. */
  __compiled(): number
}

interface Stage {
  pipeline: GPURenderPipeline
  /** Region passes' last stage: blended over the parent target. */
  over: GPURenderPipeline | null
  effect: GPUBuffer
  /** Group 2 (rebuilt when a trail's field is replaced). */
  group(): GPUBindGroup
  /** Binds group 3 (the pass's `image`), when it has one. */
  bindImage: ((rp: GPURenderPassEncoder) => void) | null
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
  /** Device px per texel (a downsampled stage's output: > 1). */
  scale: number
}

interface PassState {
  name: string
  block: ParamBlock<ParamSchema>
  radius: () => number
  /** Resolution divisor for all stages but the last (PassOptions). */
  downsample: (dpr: number) => number
  life: Lifecycle
  paramsBuf: GPUBuffer | null
  stages: Stage[]
  /** Region passes: the element, and its ping-pong pair (multi-stage). */
  region: Target | null
  ping: GPUTexture[]
  /** The `image` binding's group-3 binder (one per pass). */
  image: {
    bind: (rp: GPURenderPassEncoder) => void
    destroy: () => void
  } | null
  /** A transition's snapshot (group 3 instead of `image`). */
  snap: Snapshot | null
  /** With `sdf`: its field bound as group 3. */
  sdf: { bind: (rp: GPURenderPassEncoder) => void } | null
  /** With `textures`: their binding (group 2, from TEX_BASE). */
  tex: TextureBinding | null
}

/** First group-2 binding of a pass's textures (after trail's 3, 4). */
const TEX_BASE = 5

/** `continuous` unless given: whether a stage reads the clock. */
const passContinuous = <S extends ParamSchema>(opts: PassOptions<S>): boolean =>
  opts.continuous ??
  readsTime(...(Array.isArray(opts.fragment) ? opts.fragment : [opts.fragment]))

/** A Pass object over `s` (shared by the inert and GPU paths). */
function passHandle<S extends ParamSchema>(
  s: PassState,
  remove: () => void
): Pass<S> {
  return {
    name: s.name,
    params: s.block.values as ParamValues<S>,
    schema: s.block.schema as S,
    get enabled() {
      return s.life.enabled
    },
    set enabled(on: boolean) {
      s.life.setEnabled(on)
    },
    get continuous() {
      return s.life.continuous
    },
    set continuous(on: boolean) {
      s.life.setContinuous(on)
    },
    get radius() {
      return s.radius()
    },
    region: s.region,
    destroy: remove
  }
}

function downsampleFn<S extends ParamSchema>(
  opts: PassOptions<S>,
  values: ParamValues<S>
): (dpr: number) => number {
  const d = opts.downsample
  const clampTo = (n: number): number =>
    Math.min(4, Math.max(1, Math.round(n) || 1))
  if (typeof d === 'function') {
    return (dpr) => clampTo(d(values, dpr))
  }
  const n = clampTo(d ?? 1)
  return () => n
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

const inertComposer = createComposer(null)

function inertEffects(): Effects {
  const pointer = emptyPointer()
  const cache = new WeakMap<Element, Target>()
  const reduced = createReducedMotion()
  return {
    active: false,
    pointer,
    get reducedMotion() {
      return reduced.on
    },
    setReducedMotion(on) {
      reduced.override = on
    },
    onReducedMotion: (cb) => reduced.subscribe(cb),
    layer: (opts) => inertLayer(opts),
    material: (opts) => inertMaterial(opts, targetOf(opts.target, cache, null)),
    target: (el) => targetOf(el, cache, null),
    glyphGhost: () => null,
    pathShapes: () => [],
    transform: (el, opts) => createTransform(inertComposer, false, el, opts),
    motion: (el, opts) =>
      createMotion(inertComposer, false, el, opts, () => reduced.on),
    trail: (opts) => inertTrail(opts),
    sdf: (el, opts = {}) => inertSdf(el, opts),
    texture: (name) => inertTexture(name),
    targets: (sel, root = document) =>
      Array.from(root.querySelectorAll(sel), (el) => targetOf(el, cache, null)),
    pass<S extends ParamSchema>(opts: PassOptions<S>): Pass<S> {
      const block = createParams(opts.params ?? ({} as S), () => {})
      const s: PassState = {
        name: opts.name,
        block,
        radius: radiusFn(opts, block.values),
        downsample: downsampleFn(opts, block.values),
        life: new Lifecycle({
          enabled: opts.enabled ?? true,
          continuous: passContinuous(opts),
          timed: true,
          wake: () => {}
        }),
        paramsBuf: null,
        stages: [],
        region: opts.region ? targetOf(opts.region, cache, null) : null,
        ping: [],
        image: null,
        sdf: null,
        tex: null,
        snap: null
      }
      return passHandle<S>(s, () => s.life.destroy())
    },
    transition(opts) {
      return transitionHandle(
        this.pass({ ...opts, enabled: false }),
        null,
        () => null
      )
    },
    release() {},
    destroy() {
      reduced.destroy()
    },
    __override() {},
    __pending: () => 0,
    __compiled: () => 0
  }
}

/** What a distance field depends on in `node`'s subtree: its box and
 * every record's id (a re-read replaces them), and whether each image is
 * on the GPU yet (`uploaded`, by element). */
function contentKey(node: ElNode, uploaded: (el: Element) => number): string {
  const parts: (string | number)[] = []
  const r = node.rect
  parts.push(r.x, r.y, r.width, r.height)
  const visit = (n: ElNode): void => {
    for (const rec of n.own) {
      parts.push(rec.id)
      if (rec.kind === 'image') {
        parts.push(`i${uploaded(n.el)}`)
      }
    }
    for (const kid of n.kids) {
      if ('kids' in kid) {
        visit(kid)
      } else {
        parts.push(kid.id)
      }
    }
  }
  visit(node)
  return parts.join(',')
}

/** An Sdf without WebGPU: never ready. */
function inertSdf(el: Target | Element, opts: SdfOptions): Sdf {
  return {
    el: el instanceof Element ? el : el.el,
    spread: opts.spread ?? 32,
    resolution: opts.resolution ?? 512,
    ready: false,
    builds: 0,
    rebuild() {},
    destroy() {}
  }
}

/** Ping-pong targets are sized up to this many device px, for reuse. */
const SIZE_STEP = 64

/** One runtime per compositor (it owns the post chain), with its callers
 * counted. */
const runtimes = new WeakMap<Compositor, { fx: Effects; users: number }>()

/**
 * The effects runtime for `compositor`: the same object for every caller,
 * counted; each caller calls `release()` when done and the last release
 * destroys it. On an inert compositor (no WebGPU, or server-side) it is an
 * inert runtime: every call works and nothing renders.
 */
export function createEffects(compositor: Compositor): Effects {
  let entry = runtimes.get(compositor)
  if (!entry) {
    entry = { fx: buildEffects(compositor), users: 0 }
    runtimes.set(compositor, entry)
  }
  entry.users++
  return entry.fx
}

/** Drop `fx` as `compositor`'s runtime (it was destroyed). */
function forget(compositor: Compositor, fx: Effects): void {
  if (runtimes.get(compositor)?.fx === fx) {
    runtimes.delete(compositor)
  }
}

/** Count down one caller of `fx`; true when it was the last. */
function lastUser(compositor: Compositor, fx: Effects): boolean {
  const e = runtimes.get(compositor)
  return e?.fx !== fx || --e.users <= 0
}

function buildEffects(compositor: Compositor): Effects {
  const graph: RenderGraph | null = compositor.active ? compositor.graph : null
  if (!graph) {
    const fx = inertEffects()
    fx.release = () => {
      if (lastUser(compositor, fx)) {
        fx.destroy()
      }
    }
    const inertDestroy = fx.destroy
    fx.destroy = () => {
      inertDestroy()
      forget(compositor, fx)
    }
    return fx
  }
  const { device, format, frameLayout } = graph.shared
  const passes: PassState[] = []
  const layers: LayerState[] = []
  const materials: MaterialState[] = []
  const transforms: Transform[] = []
  const motions: Motion[] = []
  const trails: TrailState[] = []
  /** Destroyed trails, kept until teardown (consumers bind them). */
  const retired: TrailState[] = []
  const retiredSdfs: FieldSource[] = []
  const composer = createComposer(graph)
  const targetCache = new WeakMap<Element, Target>()
  let override: FxOverride | null = null
  let destroyed = false
  const reduced = createReducedMotion()
  reduced.subscribe(() => graph.requestFrame())

  /** The effects clock (clock.ts): ctx.time, held still under reduced
   * motion, or the test override. */
  const clock = new EffectsClock(reduced, () => override)
  /** Every pass, layer, material and trail's lifecycle. */
  function* lives(): Generator<Lifecycle> {
    for (const list of [passes, layers, materials, trails]) {
      for (const e of list) {
        yield e.life
      }
    }
  }
  const tracker = new PointerTracker(() => {
    if (anyEnabled(lives())) {
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
  // With `trail`: its field and info after the usual three.
  const effectTrailLayout = device.createBindGroupLayout({
    entries: [
      uniform(0),
      uniform(1),
      uniform(2),
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'read-only-storage' }
      },
      uniform(4)
    ]
  })
  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [frameLayout, srcLayout, effectLayout]
  })
  // With `textures`: group 2 grows by their entries (from TEX_BASE); the
  // layouts are made per (trail, texture count, group 3) and kept.
  const texGroupLayouts = new Map<string, GPUBindGroupLayout>()
  const texGroupLayout = (trail: boolean, n: number): GPUBindGroupLayout => {
    const key = `${trail ? 1 : 0}:${n}`
    let l = texGroupLayouts.get(key)
    if (!l) {
      l = device.createBindGroupLayout({
        label: `fx-effect+tex${n}`,
        entries: [
          uniform(0),
          uniform(1),
          uniform(2),
          ...(trail
            ? [
                {
                  binding: 3,
                  visibility: GPUShaderStage.FRAGMENT,
                  buffer: { type: 'read-only-storage' as const }
                },
                uniform(4)
              ]
            : []),
          ...textureLayoutEntries(TEX_BASE, n, GPUShaderStage.FRAGMENT)
        ]
      })
      texGroupLayouts.set(key, l)
    }
    return l
  }
  const texPipelineLayouts = new Map<string, GPUPipelineLayout>()
  const imageLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      uniform(2)
    ]
  })
  const imagePipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [frameLayout, srcLayout, effectLayout, imageLayout]
  })
  // Transitions: the snapshot as an image, plus their layer's texture.
  const prevLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      uniform(2),
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} }
    ]
  })
  const prevPipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [frameLayout, srcLayout, effectLayout, prevLayout]
  })
  const trailPrevPipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [frameLayout, srcLayout, effectTrailLayout, prevLayout]
  })
  const trailPipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [frameLayout, srcLayout, effectTrailLayout]
  })
  const trailImagePipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [frameLayout, srcLayout, effectTrailLayout, imageLayout]
  })
  const imageSampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear'
  })
  let noImage: GPUTexture | null = null
  let noImageView: GPUTextureView | null = null
  /**
   * Group 3 for a pass sampling `el`'s image record: resolved when the
   * stage draws (after the frame's uploads), rebuilt when the view
   * changes (an atlas grow), transparent until the image decodes.
   */
  const imageBinder = (
    el: Element,
    label: string
  ): { bind: (rp: GPURenderPassEncoder) => void; destroy: () => void } => {
    const info = device.createBuffer({
      label: `${label}:image`,
      size: FX_IMAGE_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    const data = new Float32Array(FX_IMAGE_BYTES / 4)
    let view: GPUTextureView | null = null
    let group: GPUBindGroup | null = null
    return {
      bind(rp) {
        const r = graph.imageOf(el)
        noImage ??= device.createTexture({
          label: 'fx:no-image',
          size: [1, 1],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING
        })
        noImageView ??= noImage.createView()
        const v = r?.view ?? noImageView
        data.fill(0)
        if (r) {
          data.set(r.uv, 0)
          data[4] = r.width
          data[5] = r.height
        }
        device.queue.writeBuffer(info, 0, data)
        if (!group || (r && v !== view) || (!r && view !== null)) {
          view = r ? v : null
          group = device.createBindGroup({
            label: `${label}:image`,
            layout: imageLayout,
            entries: [
              { binding: 0, resource: v },
              { binding: 1, resource: imageSampler },
              { binding: 2, resource: { buffer: info } }
            ]
          })
        }
        rp.setBindGroup(3, group)
      },
      destroy() {
        info.destroy()
      }
    }
  }
  /** Group 3 for a pass reading a distance field (the image layout:
   * texture, sampler, uniform), rebuilt when the field is replaced. */
  const sdfBinder = (
    f: FieldSource,
    label: string
  ): { bind: (rp: GPURenderPassEncoder) => void } => {
    let gen = -1
    let group: GPUBindGroup | null = null
    return {
      bind(rp) {
        if (!group || gen !== f.generation) {
          gen = f.generation
          group = device.createBindGroup({
            label: `${label}:sdf`,
            layout: imageLayout,
            entries: [
              { binding: 0, resource: f.view() },
              { binding: 1, resource: imageSampler },
              { binding: 2, resource: { buffer: f.infoBuffer } }
            ]
          })
        }
        rp.setBindGroup(3, group)
      }
    }
  }
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
  const effectData = new Float32Array(EFFECT_BYTES / 4)
  /** This frame's running stages, in order (filled by encode), with the
   * device px per texel each one renders at. */
  const running: { pass: PassState; stage: Stage; scale: number }[] = []

  /** In the fullscreen chain this frame (region passes never are). */
  const live = (p: PassState): boolean =>
    p.life.enabled && p.stages.length > 0 && !p.region

  const writeEffect = (
    p: PassState,
    stage: Stage,
    frame: PostFrame,
    src: Source,
    dst: { x: number; y: number },
    scale = 1
  ): void => {
    const d = effectData
    const v = frame.viewport
    d[0] = clock.time()
    d[1] = p.life.elapsed(clock)
    d[2] = v.width
    d[3] = v.height
    d[4] = 1 / Math.max(1, v.width)
    d[5] = 1 / Math.max(1, v.height)
    d[6] = frame.ctx.scrollX
    d[7] = frame.ctx.scrollY
    d[8] = frame.dpr
    d[9] = scale
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
    d[23] = src.scale
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
        const down = p.downsample(frame.dpr)
        const last = p.stages.length - 1
        p.stages.forEach((stage, k) => {
          running.push({ pass: p, stage, scale: k < last ? down : 1 })
        })
      }
      if (frame.scene !== lastScene) {
        if (lastScene) {
          srcGroups.delete(lastScene)
        }
        lastScene = frame.scene
      }
      // Transitions: take a requested snapshot of the scene before any
      // stage runs, and write the hold.
      for (const p of passes) {
        if (live(p)) {
          p.snap?.encode(frame)
        }
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
        const s = run.scale
        writeEffect(run.pass, run.stage, frame, src, { x: r.x, y: r.y }, s)
        const rp = frame.encoder.beginRenderPass({
          label: `fx:${run.pass.name}`,
          ...timed(graph.shared.timer, `fx:${run.pass.name}`),
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
        rp.setScissorRect(0, 0, Math.ceil(r.width / s), Math.ceil(r.height / s))
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
      return { view: frame.scene, x: 0, y: 0, w, h, texW: w, texH: h, scale: 1 }
    }
    const r = frame.rect
    const scale = running[i - 1]?.scale ?? 1
    return {
      view,
      x: r.x,
      y: r.y,
      w: Math.ceil(r.width / scale),
      h: Math.ceil(r.height / scale),
      texW: t.width,
      texH: t.height,
      scale
    }
  }

  const draw = (
    rp: GPURenderPassEncoder,
    stage: Stage,
    src: GPUTextureView
  ): void => {
    rp.setPipeline(stage.pipeline)
    rp.setBindGroup(1, srcGroup(src))
    rp.setBindGroup(2, stage.group())
    stage.bindImage?.(rp)
    rp.draw(3)
  }

  // Whether the pointer uniform changed this frame (materials that read
  // `pointer` then count as changed; see MaterialEntry.changed).
  let lastPointer: Float32Array | null = null
  let pointerMoved = true
  const removeHook = graph.addHook({
    beforeFrame(ctx: FrameContext) {
      clock.tick(ctx.time)
      tracker.step(ctx.dt, ctx.scrollX, ctx.scrollY)
      const o = override?.pointer
      pointerNow = o
        ? applyOverride(tracker.state, o, ctx.scrollX, ctx.scrollY)
        : tracker.state
      ctx.pointer = pointerNow
      // Before anything that reads a field this frame.
      for (const t of trails) {
        t.frame(ctx, pointerNow)
      }
      let chainLive = false
      for (const p of passes) {
        if (p.life.enabled) {
          chainLive ||= !p.region
          p.life.start(clock)
        }
        if (!p.life.enabled && p.ping.length > 0) {
          freePing(p)
        }
      }
      const any = anyEnabled(lives())
      // Before the layers' frames: a simulate dispatch is submitted there
      // and must see this frame's pointer.
      if (any) {
        const packed = tracker.pack(pointerNow)
        pointerMoved =
          lastPointer === null ||
          packed.length !== lastPointer.length ||
          packed.some((v, i) => v !== lastPointer?.[i])
        lastPointer = packed.slice()
        device.queue.writeBuffer(pointerBuf, 0, packed)
      }
      // Fields first: one whose element changed rebuilds this frame.
      for (const f of sdfs.values()) {
        const node = graph.nodeOf(f.el)
        if (node) {
          f.check(contentKey(node, (el) => graph.imageOf(el)?.width ?? 0))
        }
      }
      for (const l of layers) {
        l.frame(ctx)
      }
      for (const m of materials) {
        m.frame(ctx)
      }
      for (const p of passes) {
        p.snap?.frame()
      }
      // Leaving the offscreen path: free the ping-pong targets.
      if (!chainLive && ping.length > 0) {
        releaseTargets()
      }
    },
    keepAlive() {
      return keepAlive(
        lives(),
        clock,
        () => !override?.pointer && tracker.moving()
      )
    }
  })
  graph.setPostChain(chain)

  const buildStage = (
    name: string,
    fragment: Fragment,
    block: ParamBlock<ParamSchema>,
    paramsBuf: GPUBuffer,
    index: number,
    over: boolean,
    bindImage: ((rp: GPURenderPassEncoder) => void) | null,
    trail: TrailState | null,
    prev = false,
    sdf = false,
    tex: TextureBinding | null = null,
    texNames: readonly string[] = []
  ): Stage => {
    const label = index > 0 ? `fx:${name}#${index}` : `fx:${name}`
    const code = stageSource(
      effectSource(fragment, name),
      block.wgsl,
      bindImage !== null && !prev && !sdf,
      trail !== null,
      prev,
      sdf,
      texturesWgsl(2, TEX_BASE, texNames)
    )
    const group3 = prev ? prevLayout : bindImage ? imageLayout : null
    const g2 = tex ? texGroupLayout(trail !== null, tex.count) : null
    const texKey = `${trail ? 1 : 0}:${tex?.count ?? 0}:${prev ? 'p' : bindImage ? 'i' : '-'}`
    let texLayout = g2 ? texPipelineLayouts.get(texKey) : undefined
    if (g2 && !texLayout) {
      texLayout = device.createPipelineLayout({
        bindGroupLayouts: group3
          ? [frameLayout, srcLayout, g2, group3]
          : [frameLayout, srcLayout, g2]
      })
      texPipelineLayouts.set(texKey, texLayout)
    }
    const layout = texLayout
      ? texLayout
      : prev
        ? trail
          ? trailPrevPipelineLayout
          : prevPipelineLayout
        : trail
          ? bindImage
            ? trailImagePipelineLayout
            : trailPipelineLayout
          : bindImage
            ? imagePipelineLayout
            : pipelineLayout
    const module = device.createShaderModule({ label, code })
    reportShaderErrors(module, label)
    const pipeline = device.createRenderPipeline({
      label,
      layout,
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
          layout,
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
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: effect } },
      { binding: 1, resource: { buffer: paramsBuf } },
      { binding: 2, resource: { buffer: pointerBuf } }
    ]
    let bindGroup: GPUBindGroup | null = null
    let bound = -1
    let texBound = -1
    const group = (): GPUBindGroup => {
      const t = trail?.binding()
      const tv = tex?.version() ?? -1
      if (!bindGroup || (t && t.version !== bound) || tv !== texBound) {
        bound = t?.version ?? -1
        texBound = tv
        bindGroup = device.createBindGroup({
          label,
          layout: g2 ?? (t ? effectTrailLayout : effectLayout),
          entries: [
            ...entries,
            ...(t
              ? [
                  { binding: 3, resource: { buffer: t.field } },
                  { binding: 4, resource: { buffer: t.info } }
                ]
              : []),
            ...(tex ? tex.entries(TEX_BASE) : [])
          ]
        })
      }
      return bindGroup
    }
    return { pipeline, over: overPipeline, effect, group, bindImage }
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
    s.image?.destroy()
    s.image = null
    s.tex?.destroy()
    s.tex = null
    s.snap?.destroy()
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
    d[0] = clock.time()
    d[1] = p.life.elapsed(clock)
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
        texH: f.sourceHeight,
        scale: 1
      }
    }
    return {
      view: viewOf(view),
      x: f.x,
      y: f.y,
      w: f.width,
      h: f.height,
      texW: view.width,
      texH: view.height,
      scale: 1
    }
  }
  const regionHandler = (p: PassState): RegionHandler => ({
    pad: () => p.radius(),
    active: () => p.life.enabled && p.stages.length > 0 && !destroyed,
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
          ...timed(graph.shared.timer, `fx:${p.name}`),
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
        rp.setBindGroup(2, stage.group())
        stage.bindImage?.(rp)
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
      rp.setBindGroup(2, stage.group())
      stage.bindImage?.(rp)
      rp.draw(3)
    }
  })

  // Distance fields by handle (layers and passes resolve theirs here).
  const sdfs = new Map<Sdf, FieldSource>()
  const textureStore = new TextureStore(device, graph.assets, () =>
    graph.requestFrame()
  )
  const layerDeps = {
    textures: textureStore,
    sdfOf: (s: Sdf) => sdfs.get(s) ?? null,
    device,
    format,
    frameLayout,
    graph,
    pointerBuf,
    clock,
    pointerMoved: () => pointerMoved,
    wake: () => graph.requestFrame()
  }

  const fx: Effects = {
    active: true,
    get pointer() {
      return tracker.state
    },
    pass<S extends ParamSchema>(opts: PassOptions<S>): Pass<S> {
      const life = new Lifecycle({
        enabled: opts.enabled ?? true,
        continuous: passContinuous(opts),
        timed: true,
        wake: () => graph.requestFrame(),
        // Region passes isolate their element only while on.
        toggled: () => isolate(),
        busy: () => state.snap?.busy() ?? false
      })
      const block = createParams(opts.params ?? ({} as S), () =>
        life.paramsChanged()
      )
      const generic = block as unknown as ParamBlock<ParamSchema>
      const state: PassState = {
        name: opts.name,
        block: generic,
        radius: radiusFn(opts, block.values),
        downsample: downsampleFn(opts, block.values),
        life,
        paramsBuf: null,
        stages: [],
        region: opts.region ? targetOf(opts.region, targetCache, graph) : null,
        ping: [],
        image: null,
        sdf: null,
        tex: null,
        snap: (opts as { [SNAPSHOT]?: Snapshot })[SNAPSHOT] ?? null
      }
      const handler = state.region ? regionHandler(state) : null
      const isolate = (): void => {
        const el = state.region?.el
        if (el && handler) {
          graph.isolate(el, life.enabled && !destroyed ? handler : null)
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
        if (opts.image) {
          state.image = imageBinder(
            targetOf(opts.image, targetCache, graph).el,
            `fx:${opts.name}`
          )
        }
        const snap = state.snap
        const field =
          opts.sdf && !snap && !state.image ? sdfs.get(opts.sdf) : undefined
        if (field) {
          state.sdf = sdfBinder(field, `fx:${opts.name}`)
        }
        const bind = snap
          ? (rp: GPURenderPassEncoder) => snap.bind(rp)
          : (state.image?.bind ?? state.sdf?.bind ?? null)
        const trail = trailState(opts.trail)
        const texList = textureList(opts.textures, opts.name)
        if (texList.length) {
          state.tex = new TextureBinding(
            device,
            textureStore,
            texList,
            `fx:${opts.name}`
          )
        }
        const texNames = texList.map(([n]) => n)
        state.stages = frags.map((f, i) =>
          buildStage(
            opts.name,
            f,
            generic,
            paramsBuf,
            i,
            handler !== null && i === frags.length - 1,
            bind,
            trail,
            snap !== null,
            state.sdf !== null,
            state.tex,
            texNames
          )
        )
        passes.push(state)
        isolate()
        if (life.enabled) {
          graph.requestFrame()
        }
      }
      return passHandle<S>(state, () => {
        const i = passes.indexOf(state)
        if (i === -1) {
          return
        }
        passes.splice(i, 1)
        freePass(state)
        life.enabled = false
        isolate()
        if (passes.length === 0) {
          releaseTargets()
        }
        graph.requestFrame()
      })
    },
    transition<S extends ParamSchema>(
      opts: TransitionOptions<S>
    ): Transition<S> {
      const snap = destroyed
        ? null
        : new Snapshot(
            {
              device,
              format,
              layout: prevLayout,
              frameGroup: () => graph.shared.frameBindGroup,
              sampler,
              timer: graph.shared.timer,
              complete: () => graph.mirrorComplete(),
              wake: () => graph.requestFrame()
            },
            opts.timeout ?? 1500
          )
      const o = { ...opts, enabled: false, [SNAPSHOT]: snap }
      return transitionHandle(fx.pass<S>(o as PassOptions<S>), snap, (l) => {
        // The layer leaves the page and draws only for this transition.
        const ls = layers.find((x) => x.handle === l)
        if (!ls || ls.offscreen) {
          return null
        }
        ls.offscreen = true
        graph.requestFrame()
        return {
          overlay: { draw: (rp) => ls.drawInto(rp) },
          undo: () => {
            ls.offscreen = false
            graph.requestFrame()
          }
        }
      })
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
    material<S extends ParamSchema>(opts: MaterialOptions<S>): Material<S> {
      const target = targetOf(opts.target, targetCache, graph)
      if (destroyed) {
        return inertMaterial(opts, target)
      }
      const s = createMaterial(opts, target, layerDeps, (st) => {
        const i = materials.indexOf(st)
        if (i !== -1) {
          materials.splice(i, 1)
        }
        graph.requestFrame()
      })
      materials.push(s)
      return s.handle as unknown as Material<S>
    },
    target: (el) => targetOf(el, targetCache, graph),
    glyphGhost(el) {
      const node = graph.nodeOf(el instanceof Element ? el : el.el)
      return node ? graph.glyphGhost(targetRuns(node)) : null
    },
    pathShapes(el) {
      const node = graph.nodeOf(el instanceof Element ? el : el.el)
      return node ? pathShapesOf(node, window.scrollX, window.scrollY) : []
    },
    transform(el, opts) {
      const t = createTransform(composer, true, el, opts, () => {
        const i = transforms.indexOf(t)
        if (i !== -1) {
          transforms.splice(i, 1)
        }
      })
      transforms.push(t)
      return t
    },
    motion(el, opts) {
      const m = createMotion(
        composer,
        true,
        el,
        opts,
        () => reduced.on,
        () => {
          const i = motions.indexOf(m)
          if (i !== -1) {
            motions.splice(i, 1)
          }
        }
      )
      motions.push(m)
      return m
    },
    sdf(el, opts = {}) {
      const element = el instanceof Element ? el : el.el
      if (destroyed) {
        return inertSdf(element, opts)
      }
      if (opts.mask !== undefined) {
        const mask = new MaskField(
          device,
          graph.assets,
          element,
          opts.mask,
          () => graph.requestFrame()
        )
        let gone = false
        const handle: Sdf = {
          el: element,
          get spread() {
            return mask.spread
          },
          get resolution() {
            return mask.resolution
          },
          get ready() {
            return mask.ready
          },
          get builds() {
            return mask.builds
          },
          rebuild: () => {},
          destroy() {
            if (gone) {
              return
            }
            gone = true
            sdfs.delete(handle)
            retiredSdfs.push(mask)
            graph.requestFrame()
          }
        }
        sdfs.set(handle, mask)
        graph.requestFrame()
        return handle
      }
      const field = new SdfField(
        { device, format, frameLayout, graph },
        element,
        Math.max(1, opts.spread ?? 32),
        Math.max(16, Math.round(opts.resolution ?? 512))
      )
      graph.isolate(element, field.handler)
      let gone = false
      const handle: Sdf = {
        el: element,
        spread: field.spread,
        resolution: field.resolution,
        get ready() {
          return field.ready
        },
        get builds() {
          return field.builds
        },
        rebuild: () => field.rebuild(),
        destroy() {
          if (gone) {
            return
          }
          gone = true
          sdfs.delete(handle)
          graph.isolate(element, null)
          // Consumers may still bind its textures this frame.
          retiredSdfs.push(field)
          graph.requestFrame()
        }
      }
      sdfs.set(handle, field)
      graph.requestFrame()
      return handle
    },
    texture(name) {
      return destroyed ? inertTexture(name) : textureStore.get(name)
    },
    trail(opts = {}) {
      if (destroyed) {
        return inertTrail(opts)
      }
      const t = createTrail(opts, { device, wake: layerDeps.wake }, (st) => {
        // Consumers may still bind its (zeroed) field: freed at teardown.
        retired.push(st)
        const i = trails.indexOf(st)
        if (i !== -1) {
          trails.splice(i, 1)
        }
      })
      trails.push(t)
      return t.handle
    },
    release() {
      if (lastUser(compositor, fx)) {
        fx.destroy()
      }
    },
    targets: (sel, root = document) =>
      Array.from(root.querySelectorAll(sel), (el) =>
        targetOf(el, targetCache, graph)
      ),
    destroy() {
      if (destroyed) {
        return
      }
      destroyed = true
      forget(compositor, fx)
      reduced.destroy()
      tracker.unlisten()
      removeHook()
      for (const t of [...transforms]) {
        t.destroy()
      }
      transforms.length = 0
      for (const m of [...motions]) {
        m.destroy()
      }
      motions.length = 0
      composer.clear()
      graph.setPostChain(null)
      for (const p of passes) {
        freePass(p)
        p.life.enabled = false
        if (p.region) {
          graph.isolate(p.region.el, null)
        }
      }
      passes.length = 0
      for (const l of [...layers]) {
        l.handle.destroy()
      }
      layers.length = 0
      for (const m of [...materials]) {
        m.handle.destroy()
      }
      materials.length = 0
      for (const t of [...trails]) {
        t.handle.destroy()
      }
      for (const t of retired) {
        t.free()
      }
      retired.length = 0
      for (const h of [...sdfs.keys()]) {
        h.destroy()
      }
      for (const f of retiredSdfs) {
        f.destroy()
      }
      retiredSdfs.length = 0
      releaseTargets()
      pointerBuf.destroy()
      noImage?.destroy()
      textureStore.destroy()
    },
    get reducedMotion() {
      return reduced.on
    },
    setReducedMotion(on) {
      reduced.override = on
    },
    onReducedMotion: (cb) => reduced.subscribe(cb),
    __override(o) {
      override = o
      graph.requestFrame()
    },
    __pending: () => graph.materialsPending(),
    __compiled: () => materialPipelinesSettled()
  }
  return fx
}
