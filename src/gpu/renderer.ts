import type { DrawBatch } from '../scene/batches'
import type { DropShadow } from '../scene/filter'
import type { BackdropRecord, Rect } from '../scene/records'
import type { Scene } from '../scene/scene'
import type { OpacityGroup } from '../scene/stacking'
import type { FrameContext, Layer } from '../types'
import { BackdropPass } from './backdrop'
import { GroupCompositor, type GroupTarget, rectQuad } from './composite'
import { Culler, type Runs } from './cull'
import type { GpuContext } from './device'
import { type EffectSnapshot, snapshotEffects } from './effect_snapshot'
import { type DrawPlan, type FillInput, FillPlanner } from './fill_planner'
import {
  CLIP_FLOATS,
  FRAME_BYTES,
  MAX_CLIP_SHAPES,
  type RenderPass,
  type Shared
} from './frame'
import {
  ClearRect,
  CopyThrough,
  type DeviceRect,
  type ExtraLayer,
  type LayerTransform,
  type MaterialEntry,
  type PostChain,
  type PostFrame,
  type RegionFrame,
  type RegionHandler
} from './graph'
import { downFactor, GroupBlur } from './group_blur'

import {
  type CacheContext,
  GroupCache,
  hashValues,
  type Rendered
} from './group_cache'
import {
  type GroupPlace,
  type LevelPlan,
  type PlanInput,
  planLevel,
  popOf,
  stepUp
} from './group_plan'
import {
  type Affine,
  apply,
  type Box4,
  groupExtent,
  layerAffine,
  layerAlpha,
  mapRect
} from './layer_geometry'
import { materialPipelinesSettled } from './material'
import { addRows, clamp, hullRows, meet } from './rows'
import { type GpuFrameTiming, GpuTimer, timed } from './timer'

/** Scale steps an octave for transformed groups' textures (kept ones
 * re-render once a step during a scale animation). */
const SCALE_STEPS = 8
/** Frames a transformed group's scale holds before it renders at it
 * exactly (until then, rounded up to a step). */
const SCALE_SETTLE = 4
/** Parent device px a transformed group's cut is rounded out to. */
const CLIP_GRID = 256

interface FrameSlot {
  buffer: GPUBuffer
  bindGroup: GPUBindGroup
}

/** A render target on the group stack (the canvas, or a group texture). */
interface Target {
  view: GPUTextureView
  /** Bind group 0 whose Frame maps doc space onto this target. */
  bindGroup: GPUBindGroup
  /** Doc-space position of the target's top-left pixel. */
  ox: number
  oy: number
  /** Size in device px. */
  devW: number
  devH: number
  /** Device px per CSS px. */
  sx: number
  sy: number
  /** Scene.groups index; -1 for the canvas. */
  group: number
  /** The pooled texture; null for the canvas. */
  pooled: GroupTarget | null
  /** Doc-space rect (minX, minY, maxX, maxY) to composite onto the parent,
   * and the used region's size in device px. */
  rect: [number, number, number, number]
  w: number
  h: number
  /** Top-left of the used region in the parent target's device px. */
  px: number
  py: number
  /** A layer transform's doc-space affine (null: composite in place). */
  xf: Affine | null
  /** Set when a region handler composites it (encoded in prepare). */
  region?: RegionFrame
  /** Device-px rect (x, y, w, h) its passes draw within; absent: all of
   * it (CompositorOptions.canvasFill: the main target's visible band; a
   * group in a group atlas: its rect). */
  scissor?: [number, number, number, number]
  /** In a group atlas: the device px of `pooled` where this group's
   * texture starts (absent: 0, 0). */
  uv0?: [number, number]
}

/**
 * Owns the shared frame uniforms and drives the per-frame render: update
 * uniforms, (re-)upload dirty passes, walk the batch list (one render pass
 * per target segment; see render()), submit.
 */
export class Renderer {
  private readonly device: GPUDevice
  private readonly frameBuffer: GPUBuffer
  /** Clip shapes (frame.ts FrameClip), bound in every bind group 0. */
  private readonly clipBuffer: GPUBuffer
  private readonly clipData = new Float32Array(MAX_CLIP_SHAPES * CLIP_FLOATS)
  /** Scene.version the clip table was last uploaded for. */
  private clipVersion = -1
  /** The scene being rendered (for clip shape indices). */
  private scene: Scene | null = null
  readonly shared: Shared
  private readonly passes: RenderPass[] = []
  private readonly passByLayer = new Map<Layer, RenderPass>()
  private readonly frameData = new Float32Array(FRAME_BYTES / 4)
  /** Layers re-uploaded in the most recent render (for debug/stats). */
  lastUploads = 0
  /** Draw batches issued in the most recent render (for debug/stats). */
  lastBatches = 0
  /** Opacity groups composited in the most recent render. */
  lastGroups = 0
  /** `encoder.draw` calls issued by passes in the most recent render (for
   * debug/stats) — lower than `lastBatches` when a pass collapses several
   * instances into one draw (e.g. atlas-backed images). */
  lastDraws = 0
  /** The most recent render ran the post chain on the previous frame's
   * scene texture instead of redrawing the scene (see reuseKey). */
  lastReused = false
  /** CompositorOptions.sceneReuse. */
  reuseScene = true
  /** The skeleton view (gpu/skeleton.ts). Switching it redraws the band
   * and the scene. */
  get skeleton(): boolean {
    return this.shared.skeleton
  }
  set skeleton(on: boolean) {
    if (on === this.shared.skeleton) {
      return
    }
    this.shared.skeleton = on
    this.groupCache.clear()
    this.planner.invalidate()
    this.sceneKey = null
  }
  /** CompositorOptions.skipUnchanged: with canvasFill 'band', draw only
   * band rows not drawn since the content last changed, and skip frames
   * with nothing to draw. */
  skipUnchanged = true
  /** The most recent frame drew nothing (skipUnchanged). */
  lastSkipped = false
  /** Frames skipped since creation (stats().skippedFrames). */
  skippedFrames = 0
  /** Wall time spent in pass uploads in the most recent render, ms. */
  lastUploadMs = 0
  /** Wall time from createCommandEncoder to submit in the most recent
   * render, ms. */
  lastEncodeMs = 0
  /** Upload wall time per layer in the most recent render, ms (layers
   * not re-uploaded are absent). */
  lastUploadByLayer: Partial<Record<Layer, number>> = {}
  /** Frames rendered (GpuFrameTiming.frame refers to it). */
  frames = 0
  private readonly composite: GroupCompositor
  private readonly groupCache: GroupCache
  /** CSS `filter: blur()` on groups (made on first use). */
  private groupBlur: GroupBlur | null = null
  /** CSS `backdrop-filter` draws (made on first use). */
  private backdrop: BackdropPass | null = null
  /** The canvas was configured with TEXTURE_BINDING (for backdrops). */
  private canvasSampled = false
  /** Skip instances outside the canvas region, or the band with
   * `canvasFill: 'band'` (CompositorOptions.cullDraws). */
  cullDraws: boolean | 'canvas' = true
  /** The main target's draw culling and its caches (cull.ts). Batches of
   * non-builtin materials are drawn whole: vertex hooks may move geometry
   * anywhere. */
  private readonly culler = new Culler((id) => {
    const m = this.materials.get(id)
    return m !== undefined && !m.builtin
  })
  /** Instances submitted in the last frame (stats().instances). */
  lastInstances = 0
  /** Render passes the last frame spent on group textures
   * (stats().groupPasses). */
  lastGroupPasses = 0
  /** Render leaf groups into one shared texture and pass
   * (CompositorOptions.groupAtlas). */
  groupAtlas = true
  /** Keep opacity-group textures between frames while their content is
   * unchanged (group_cache.ts; CompositorOptions.groupCache). */
  cacheGroups = true
  /** Set by the compositor each frame: the mirror is complete (fonts,
   * images, compiles), so a group's texture is final and can be kept. */
  cacheReady = true
  /** Image records change without new records (image fades running). */
  imagesVolatile = false
  /** Glyphs move without new records (CompositorOptions.onGlyph). */
  textVolatile = false
  /** Groups drawn from a kept texture / rendered, last frame. */
  lastGroupHits = 0
  lastGroupMisses = 0
  /** Last frame's groups rendered afresh, by reason, and the first few
   * (the profiler's FrameWhy.groups). */
  lastGroupWhy: Record<string, number> = {}
  lastGroupRendered: Rendered[] = []
  /** What material `id` contributes to group `g`'s kept texture this
   * frame (CacheContext.materialKey): off, or not reaching the group's
   * box (MaterialEntry.reach), it draws as the records' own colours (a
   * constant); reaching it, its version (bumped whenever it can draw
   * differently); null when it can't say. */
  private materialKey(
    id: number,
    g: OpacityGroup,
    ctx: FrameContext
  ): number | null {
    const m = this.materials.get(id)
    if (m?.builtin) {
      return 2 + id
    }
    if (!m?.active()) {
      return 0
    }
    const reach = m.reach?.() ?? 'all'
    const b = g.bounds
    if (reach === 'none') {
      return 1
    }
    if (reach !== 'all' && b) {
      // The group's box in viewport px (its records, untransformed: a
      // material shades them before a layer transform applies).
      const x0 = b.x - ctx.scrollX
      const y0 = b.y - ctx.scrollY
      const dx = Math.max(x0 - reach.x, 0, reach.x - (x0 + b.width))
      const dy = Math.max(y0 - reach.y, 0, reach.y - (y0 + b.height))
      if (dx * dx + dy * dy > (reach.r + 1) * (reach.r + 1)) {
        return 1
      }
    }
    if (m.changed === undefined || m.version === undefined) {
      return null
    }
    // Apart from the builtins' ids.
    return 0x10000 + m.version
  }

  /** Transformed groups' scales last frame, by cache key (scaleOf). */
  private lastScale = new Map<
    object,
    { kx: number; ky: number; held: number }
  >()
  /** Last frame drew a transformed group at a rounded scale: draw again
   * (the compositor asks for a frame; the layers' rows count as live). */
  scaleSettling = false
  /** ms the last frame spent recomputing culled runs; 0 when cached
   * (stats().cullMs). */
  lastCullMs = 0
  /** 'band': draw only the viewport plus a band above and below it, the
   * rest kept from earlier frames; 'band-clear': the rest cleared
   * (CompositorOptions.canvasFill). */
  canvasFill: 'full' | 'band' | 'band-clear' = 'band'
  /** canvasFill 'band': rows a re-anchor newly covers are cleared and
   * drawn a strip per frame, nearest the band first, culled to them;
   * false draws them all in the re-anchor frame (not culled to the band). */
  reanchorStrips = true
  /** canvasFill 'band': the canvas's pixels kept between frames (a
   * canvas texture isn't), and a same-size texture to shift them into
   * when the canvas re-anchors. */
  private kept: GPUTexture | null = null
  private keptView: GPUTextureView | null = null
  private keptSpare: GPUTexture | null = null
  /** The kept texture's rows: what each frame draws, what stays valid
   * (fill_planner.ts). */
  private readonly planner = new FillPlanner()
  /** This frame's effect registries view (effect_snapshot.ts). */
  private fx: EffectSnapshot | null = null
  /** The pending interval this frame's strip was taken from (stripRuns). */
  private stripFrom: [number, number] | null = null
  /** The rows viewport-space (fixed) content covers, as viewport-y CSS
   * px intervals, merged (cached per batch list and version). */
  private fixedOf: {
    batches: Scene['batches']
    version: number
    rows: [number, number][]
  } | null = null
  private clearRect: ClearRect | null = null
  /** This frame's band in document CSS px (y0, y1), or null when the
   * whole canvas is drawn (cullFor). */
  private bandY: [number, number] | null = null
  /** Device-px rows a re-anchor covered not yet drawn. */
  get pendingRowCount(): number {
    return this.planner.pendingRowCount
  }
  /** Device-px rows the last frame's main pass drew (stats().fillRows). */
  lastFillRows = 0
  /** Frame uniforms for group targets, one per group slot in a frame
   * (sibling groups need distinct buffers: writeBuffer lands before
   * submit). Reused across frames. */
  private readonly groupFrames: FrameSlot[] = []
  /** The effects layer's post chain (gpu/graph.ts). While it is active the
   * scene renders into `sceneTexture` and the chain runs before the canvas
   * composite; otherwise render() draws straight to the swapchain. */
  postChain: PostChain | null = null
  /** Extra layers by id (scene.batches `extra` entries; gpu/graph.ts). */
  readonly extras = new Map<number, ExtraLayer>()
  /** Region handlers by id (OpacityGroup.region; gpu/graph.ts). */
  readonly regions = new Map<number, RegionHandler>()
  /** Layer transforms by id (OpacityGroup.region; gpu/graph.ts). A region
   * handler with the same id takes precedence. */
  readonly transforms = new Map<number, LayerTransform>()
  /** Materials by id (DrawBatch.material; gpu/graph.ts). */
  readonly materials = new Map<number, MaterialEntry>()
  private sceneTexture: GPUTexture | null = null
  private sceneView: GPUTextureView | null = null
  /** What `sceneTexture` holds: the reuseKey and batch list it was drawn
   * from (null: nothing reusable). */
  private sceneKey: string | null = null
  private sceneBatches: readonly DrawBatch[] | null = null
  private copy: CopyThrough | null = null

  constructor(private readonly gpu: GpuContext) {
    this.device = gpu.device
    this.frameBuffer = this.device.createBuffer({
      size: FRAME_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    this.clipBuffer = this.device.createBuffer({
      label: 'clip-shapes',
      size: MAX_CLIP_SHAPES * CLIP_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    const frameLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' }
        }
      ]
    })
    const frameBindGroup = this.device.createBindGroup({
      layout: frameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: { buffer: this.clipBuffer } }
      ]
    })
    this.shared = {
      device: this.device,
      format: gpu.viewFormat,
      frameLayout,
      frameBindGroup,
      dpr: 1,
      timer: null,
      skeleton: false
    }
    this.composite = new GroupCompositor(this.shared)
    this.groupCache = new GroupCache((t) => this.composite.release(t))
  }

  /** Forget material `id`'s cached pipelines in every pass. */
  dropMaterial(id: number): void {
    this.materials.delete(id)
    for (const pass of this.passes) {
      pass.dropMaterial?.(id)
    }
  }

  /** Start compiling material `mat`'s pipelines in every pass. */
  warmMaterial(mat: MaterialEntry): void {
    for (const pass of this.passes) {
      pass.warmMaterial?.(mat)
    }
  }

  addPass(pass: RenderPass): void {
    this.passes.push(pass)
    this.passByLayer.set(pass.layer, pass)
  }

  private writeFrame(ctx: FrameContext, dpr: number): void {
    // The canvas covers [canvasX, canvasX + canvasWidth) in doc space. A
    // viewport-space position p is at doc p + scroll, so canvas p + scroll
    // - canvasX: vscroll is the canvas origin in viewport space.
    const f = this.frameData
    f[0] = ctx.canvasWidth
    f[1] = ctx.canvasHeight
    f[2] = ctx.canvasX
    f[3] = ctx.canvasY
    f[4] = ctx.time
    f[5] = dpr
    f[6] = ctx.canvasX - ctx.scrollX
    f[7] = ctx.canvasY - ctx.scrollY
    this.device.queue.writeBuffer(this.frameBuffer, 0, f)
  }

  /** `clip`'s shape index in the scene being rendered (0: none). Group
   * clips are indexed when the scene is built, so this only looks up. */
  private clipIndexOf(clip: Rect | null | undefined): number {
    return this.scene?.clipIndex(clip) ?? 0
  }

  /** Upload the scene's clip shapes (slot i + 1 for clipShapes[i]). */
  private writeClips(scene: Scene): void {
    const n = Math.min(scene.clipShapes.length, MAX_CLIP_SHAPES - 1)
    if (n === 0) {
      return
    }
    const d = this.clipData
    for (let i = 0; i < n; i++) {
      const c = scene.clipShapes[i]
      if (!c) {
        continue
      }
      let o = (i + 1) * CLIP_FLOATS
      d[o++] = c.inv[0]
      d[o++] = c.inv[1]
      d[o++] = c.inv[2]
      d[o++] = c.inv[3]
      d[o++] = c.inv[4]
      d[o++] = c.inv[5]
      d[o++] = c.w
      d[o++] = c.h
      for (let k = 0; k < 4; k++) {
        d[o++] = c.radius[k] ?? 0
      }
      for (let k = 0; k < 4; k++) {
        d[o++] = c.radiusY[k] ?? 0
      }
    }
    this.device.queue.writeBuffer(
      this.clipBuffer,
      0,
      d,
      0,
      (n + 1) * CLIP_FLOATS
    )
  }

  /** Frame uniform + bind group 0 for the `slot`th group of this frame. */
  private groupFrame(slot: number): FrameSlot {
    let f = this.groupFrames[slot]
    if (!f) {
      const buffer = this.device.createBuffer({
        size: FRAME_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      })
      const bindGroup = this.device.createBindGroup({
        layout: this.shared.frameLayout,
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: { buffer: this.clipBuffer } }
        ]
      })
      f = { buffer, bindGroup }
      this.groupFrames[slot] = f
    }
    return f
  }

  private beginPass(
    encoder: GPUCommandEncoder,
    t: Target,
    loadOp: GPULoadOp,
    label: string
  ): GPURenderPassEncoder {
    const rp = encoder.beginRenderPass({
      ...timed(this.shared.timer, label),
      colorAttachments: [
        {
          view: t.view,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp,
          storeOp: 'store'
        }
      ]
    })
    rp.setBindGroup(0, t.bindGroup)
    if (t.scissor) {
      rp.setScissorRect(...t.scissor)
    }
    return rp
  }

  /** Back to `t`'s own scissor after a narrower one. */
  private restoreScissor(rp: GPURenderPassEncoder, t: Target): void {
    const [x, y, w, h] = t.scissor ?? [0, 0, t.devW, t.devH]
    rp.setScissorRect(x, y, w, h)
  }

  /** Viewport-y intervals (CSS px) that fixed content paints, padded for
   * anti-aliasing and text shadows. */
  private fixedRows(scene: Scene): [number, number][] {
    const c = this.fixedOf
    if (c && c.batches === scene.batches && c.version === scene.version) {
      return c.rows
    }
    let rows: [number, number][] = []
    const add = (r: Rect, pad: number): void => {
      rows = addRows(rows, r.y - pad, r.y + r.height + pad)
    }
    for (const list of [
      scene.boxes,
      scene.images,
      scene.cutouts,
      scene.paths
    ]) {
      for (const r of list) {
        if (r.space === 'viewport') {
          add(r.rect, 2)
        }
      }
    }
    for (const run of scene.runs) {
      if (run.space !== 'viewport') {
        continue
      }
      let pad = 2
      for (const sh of run.textShadows ?? []) {
        pad = Math.max(pad, Math.abs(sh.oy) + 1.5 * sh.blur + 2)
      }
      for (const g of run.glyphs) {
        add(g.rect, pad)
      }
    }
    for (const g of scene.groups) {
      if (g.vbounds) {
        add(g.vbounds, 2)
      }
    }
    this.fixedOf = { batches: scene.batches, version: scene.version, rows }
    return rows
  }

  /**
   * Walk scene.batches in order. A push ends the current render pass and
   * begins one on a pooled offscreen target (cleared) whose Frame uniform
   * maps the group's viewport-clipped doc rect onto the texture (and, via
   * `vscroll`, the same rect in viewport space for fixed records); the
   * matching pop ends it, resumes the parent target (loadOp 'load') and
   * composites the texture there with the group's alpha. Passes only ever
   * see a render pass with bind group 0 set.
   */
  render(scene: Scene, ctx: FrameContext, dpr: number): void {
    this.scene = scene
    const chain = this.postChain?.active() ? this.postChain : null
    const canvas = this.gpu.context.canvas
    // Before the uploads clear the dirty flags.
    const dirty = this.passes.some((p) => scene.isDirty(p.layer))
    const fx = snapshotEffects(this, {
      scene,
      ctx,
      dpr,
      dirty,
      settled: materialPipelinesSettled(),
      pendingRows: this.planner.pendingRowCount > 0
    })
    this.fx = fx
    const fill: FillInput = {
      now: performance.now(),
      scrollY: ctx.scrollY,
      height: ctx.height,
      canvasX: ctx.canvasX,
      canvasY: ctx.canvasY,
      devW: canvas.width,
      devH: canvas.height,
      sx: ctx.canvasWidth > 0 ? canvas.width / ctx.canvasWidth : dpr,
      sy: ctx.canvasHeight > 0 ? canvas.height / ctx.canvasHeight : dpr,
      canvasFill: this.canvasFill,
      skipUnchanged: this.skipUnchanged,
      reanchorStrips: this.reanchorStrips,
      chain: chain !== null,
      backdrop: scene.backdrops.length > 0,
      content: fx.content,
      // A group drawn at a rounded scale is drawn again at its own.
      layers: this.scaleSettling ? { ...fx.layers, live: true } : fx.layers,
      fixed: () => this.fixedRows(scene)
    }
    // The post chain over last frame's scene texture: nothing feeding it
    // changed.
    const key = chain && this.reuseScene ? fx.reuseKey() : null
    const reuse =
      chain !== null &&
      key !== null &&
      key === this.sceneKey &&
      scene.batches === this.sceneBatches &&
      this.sceneTexture?.width === canvas.width &&
      this.sceneTexture.height === canvas.height &&
      !dirty
    let fillPlan: DrawPlan | null = null
    if (reuse) {
      this.planner.reuse(fill)
    } else {
      const p = this.planner.plan(fill)
      if (p.kind === 'skip') {
        this.lastSkipped = true
        this.skippedFrames++
        this.lastFillRows = 0
        this.lastBatches = 0
        this.lastDraws = 0
        this.lastInstances = 0
        this.lastGroups = 0
        this.lastGroupPasses = 0
        this.lastGroupHits = 0
        this.lastGroupMisses = 0
        this.lastGroupWhy = {}
        this.lastGroupRendered = []
        this.scaleSettling = false
        this.lastUploads = 0
        this.lastUploadMs = 0
        this.lastUploadByLayer = {}
        this.lastEncodeMs = 0
        this.lastCullMs = 0
        return
      }
      fillPlan = p
    }
    this.lastSkipped = false
    if (scene.backdrops.length > 0 && !this.canvasSampled) {
      // Backdrops read the canvas texture they were drawn over.
      this.canvasSampled = true
      this.gpu.context.configure({
        device: this.device,
        format: this.gpu.format,
        alphaMode: 'premultiplied',
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      })
    }
    const texture = this.gpu.context.getCurrentTexture()
    if (!fillPlan) {
      if (chain) {
        this.renderPostOnly(chain, texture, ctx, dpr)
      }
      return
    }
    this.lastReused = false
    this.writeFrame(ctx, dpr)
    if (scene.version !== this.clipVersion) {
      this.clipVersion = scene.version
      this.writeClips(scene)
    }
    this.shared.dpr = dpr
    // Upload only the layers that changed since they were last drawn.
    let uploads = 0
    let uploadMs = 0
    const byLayer: Partial<Record<Layer, number>> = {}
    for (const pass of this.passes) {
      if (scene.isDirty(pass.layer)) {
        const t0 = performance.now()
        pass.upload(scene)
        const ms = performance.now() - t0
        uploadMs += ms
        byLayer[pass.layer] = ms
        scene.clearDirty(pass.layer)
        uploads++
      }
    }
    this.lastUploads = uploads
    this.lastUploadMs = uploadMs
    this.lastUploadByLayer = byLayer
    const encodeStart = performance.now()
    const timer = this.shared.timer
    this.frames++
    timer?.begin(this.frames)
    const encoder = this.device.createCommandEncoder()
    const canvasView = texture.createView({ format: this.gpu.viewFormat })
    if (!chain && this.sceneTexture) {
      this.releaseScene()
    }
    const main: Target = {
      view: chain ? this.sceneTarget(texture) : canvasView,
      bindGroup: this.shared.frameBindGroup,
      ox: ctx.canvasX,
      oy: ctx.canvasY,
      devW: texture.width,
      devH: texture.height,
      sx: ctx.canvasWidth > 0 ? texture.width / ctx.canvasWidth : dpr,
      sy: ctx.canvasHeight > 0 ? texture.height / ctx.canvasHeight : dpr,
      group: -1,
      pooled: null,
      rect: [0, 0, 0, 0],
      w: 0,
      h: 0,
      px: 0,
      py: 0,
      xf: null
    }
    this.bandY = fillPlan.bandY
    this.stripFrom = fillPlan.stripFrom
    if (fillPlan.keep) {
      this.keepTexture(encoder, texture, fillPlan)
      main.view = this.keptView ?? canvasView
    } else if (this.kept) {
      this.releaseKept()
    }
    const band = fillPlan.band ?? undefined
    const strip = fillPlan.strip ?? undefined
    const extra = fillPlan.extra
    const cleared = fillPlan.cleared
    const mainLoad: GPULoadOp = fillPlan.load
    main.scissor = band
    this.lastFillRows = fillPlan.fillRows
    // A strip or an extra draw composites every group again.
    this.composite.begin(
      scene.groups.length * (1 + extra.length + (strip ? 1 : 0))
    )
    this.groupBlur?.begin()
    this.groupCache.begin()
    const cacheOn = this.cacheGroups && this.cacheReady && !this.shared.skeleton
    const cacheCtx: CacheContext = {
      scene,
      list: scene.batches,
      dpr,
      imagesVolatile: this.imagesVolatile,
      textVolatile: this.textVolatile,
      materialKey: (id, g) => this.materialKey(id, g, ctx),
      nested: (i) => {
        const e = fx.effectOf(scene.groups[i])
        if (e?.kind === 'region') {
          return e.region.key?.() ?? 'nested region'
        }
        // Called while groups render, after xfs is filled below: the
        // affine and opacity it composites with.
        const xf = xfs[i]
        if (e?.kind === 'transform' && xf) {
          return hashValues([...xf, e.transform.opacity])
        }
        return null
      }
    }
    if (scene.backdrops.length > 0) {
      this.backdrop ??= new BackdropPass(this.shared)
      let ops = 0
      for (const b of scene.backdrops) {
        ops += b.filter.matrices.length
      }
      this.backdrop.begin(scene.backdrops.length, ops)
    }
    let batches = 0
    let groups = 0
    let groupPasses = 0
    let draws = 0
    let instances = 0
    this.lastCullMs = 0
    let culled = this.cullDraws ? this.cullFor(scene, ctx) : null
    if (fillPlan.cull === 'strip' && culled && band) {
      culled = this.stripRuns(scene, ctx, main, band)
    } else if (fillPlan.cull === 'rows' && culled && band) {
      culled = this.rowRuns(scene, ctx, main, band)
    }
    let slot = 0
    const list = scene.batches
    // Two phases. Every group's texture is rendered first (children before
    // parents, each in its own pass), then each target's pass draws its
    // batches and composites its child groups in place. A target's pass is
    // split only at a backdrop-filter (drawBackdrop), so groups cost no
    // reload of their parent (the main target is the whole canvas).
    /** By push index: a rendered group, or 'in-place' (drawn in its
     * parent's pass), or 'skip' (nothing to draw). */
    const plan = new Map<number, Target | 'in-place' | 'skip'>()
    // Layer transforms by group, and extents grown by transformed
    // descendants (an enclosing group's texture must hold where they land).
    const xfs: (Affine | null)[] = []
    const extents: (Box4 | null)[] = []
    for (let gi = 0; gi < scene.groups.length; gi++) {
      const g = scene.groups[gi]
      const e = fx.effectOf(g)
      xfs[gi] =
        g && e?.kind === 'transform' ? layerAffine(g, e.transform, ctx) : null
    }

    // Draws list[start, end) into `target`; returns the pass to continue
    // with (a backdrop ends the pass it was given and begins another).
    const drawRange = (
      first: GPURenderPassEncoder,
      target: Target,
      start: number,
      end: number,
      label: string
    ): GPURenderPassEncoder => {
      let rp = first
      for (let i = start; i < end; i++) {
        const batch = list[i]
        if (!batch) {
          continue
        }
        if (batch.kind === 'push') {
          const p = plan.get(i)
          if (p === 'in-place') {
            continue
          }
          const j = popOf(list, i, batch.group)
          if (p && p !== 'skip') {
            if (
              this.compositeGroup(rp, p, target, scene.groups[batch.group], ctx)
            ) {
              groups++
            }
          }
          i = j
        } else if (batch.kind === 'pop') {
          // An in-place group's pop.
        } else if (batch.kind === 'extra') {
          const layer = this.extras.get(batch.id)
          if (layer?.active()) {
            layer.draw(rp, ctx)
            draws++
          }
        } else if (batch.kind === 'backdrop') {
          const rec = scene.backdrops[batch.index]
          if (rec) {
            rp = this.drawBackdrop(encoder, rp, target, rec, ctx, label)
            draws++
          }
        } else {
          const pass = this.passByLayer.get(batch.layer)
          if (!pass) {
            continue
          }
          const mat =
            batch.material !== undefined
              ? this.materials.get(batch.material)
              : undefined
          const binding = mat?.active() ? mat : null
          const runs = target.group === -1 ? culled?.[i] : null
          if (runs) {
            for (let r = 0; r < runs.length; r += 2) {
              const n = runs[r + 1] ?? 0
              draws += pass.draw(rp, runs[r] ?? 0, n, binding)
              instances += n
            }
          } else {
            draws += pass.draw(rp, batch.first, batch.count, binding)
            instances += batch.count
          }
          batches++
        }
      }
      return rp
    }

    // Rounded for every transformed group, kept or not: a group that
    // can't be kept is the parent whose scale and cut its children's
    // placement follows (a scrubbed card around a kept screenshot).
    // A transformed group's scale: exact once it has held SCALE_SETTLE
    // frames, rounded up to a step while it changes (a kept texture lasts
    // the step).
    const lastScale = this.lastScale
    const nextScale = new Map<
      object,
      { kx: number; ky: number; held: number }
    >()
    let stepped = false
    this.lastScale = nextScale
    const scaleOf = (
      g: OpacityGroup,
      kx: number,
      ky: number
    ): [number, number] => {
      const key = this.groupCache.keyOf(g)
      if (!key) {
        return [kx, ky]
      }
      const was = lastScale.get(key)
      const held =
        was && was.kx === kx && was.ky === ky ? Math.min(was.held + 1, 99) : 0
      nextScale.set(key, { kx, ky, held })
      if (held >= SCALE_SETTLE) {
        return [kx, ky]
      }
      const q: [number, number] = [
        stepUp(kx, SCALE_STEPS),
        stepUp(ky, SCALE_STEPS)
      ]
      if (q[0] !== kx || q[1] !== ky) {
        stepped = true
      }
      return q
    }
    const planInput: PlanInput = {
      list,
      groups: scene.groups,
      effectOf: (g) => fx.effectOf(g),
      xfs,
      extents,
      ctx,
      maxTexture: this.device.limits.maxTextureDimension2D,
      groupAtlas: this.groupAtlas,
      scaleOf: cacheOn ? scaleOf : undefined,
      clipGrid: cacheOn ? () => CLIP_GRID : undefined
    }
    /** Render the groups `level` (group_plan.ts) places in `parent`:
     * children before parents, each in its own pass; leaves share one
     * atlas texture and pass. */
    const renderLevel = (level: LevelPlan, parent: Target): void => {
      for (const step of level.steps) {
        if (step.kind === 'in-place') {
          plan.set(step.i, 'in-place')
          renderLevel(step.inner, parent)
          continue
        }
        if (step.kind === 'skip') {
          plan.set(step.i, 'skip')
          continue
        }
        const m = step.place
        // An unchanged group draws from the texture it was kept with.
        const g = scene.groups[step.group]
        const key = g ? this.groupCache.keyOf(g) : undefined
        const sig =
          cacheOn && g && key && !step.region
            ? this.groupCache.signature(
                cacheCtx,
                g,
                step.i,
                step.j,
                m,
                step.blur,
                step.shadows
              )
            : null
        const place = this.groupCache.lastPlace
        const kept = key && sig !== null ? this.groupCache.get(key, sig) : null
        if (!kept) {
          this.groupCache.note(
            key,
            !cacheOn
              ? this.cacheGroups
                ? 'loading'
                : 'off'
              : step.region
                ? 'region'
                : this.groupCache.reason
          )
        }
        if (kept) {
          const child = this.finishGroup(m, kept, 0, 0, slot, ctx)
          slot++
          child.group = step.group
          plan.set(step.i, child)
          continue
        }
        const child = this.finishGroup(
          m,
          this.composite.acquire(m.w, m.h),
          0,
          0,
          slot,
          ctx
        )
        slot++
        child.group = step.group
        plan.set(step.i, child)
        renderLevel(planLevel(child, step.i + 1, step.j, planInput), child)
        groupPasses++
        const rp = drawRange(
          this.beginPass(encoder, child, 'clear', step.label),
          child,
          step.i + 1,
          step.j,
          step.label
        )
        rp.end()
        if (step.blur > 0) {
          this.blurGroup(encoder, child, step.blur)
        }
        for (const sh of step.shadows) {
          this.shadowGroup(encoder, child, sh)
        }
        if (key && sig !== null && child.pooled) {
          this.groupCache.put(key, sig, child.pooled, place)
        }
        if (step.region && child.pooled) {
          const g = scene.groups[step.group]
          child.region = this.regionFrame(child, parent, g, encoder, ctx, dpr)
          step.region.encode(child.region)
        }
      }
      if (level.leaves.length > 0) {
        renderLeaves(level)
      }
    }
    /** Render `level`'s leaves: those packed share one atlas texture and
     * pass, the rest get their own. */
    const renderLeaves = (level: LevelPlan): void => {
      const { leaves, packed } = level
      // A leaf unchanged since last frame gets a texture of its own and
      // keeps it (one that changes every frame stays in the atlas).
      const keep: { sig: number; place: number }[] = []
      const own: (GroupTarget | 'render' | null)[] = leaves.map((l, k) => {
        const lg = scene.groups[l.group]
        const key = lg ? this.groupCache.keyOf(lg) : undefined
        if (!cacheOn) {
          this.groupCache.note(key, this.cacheGroups ? 'loading' : 'off')
          return null
        }
        const sig =
          lg && key
            ? this.groupCache.signature(cacheCtx, lg, l.i, l.j, l.m, 0, [])
            : null
        if (!key || sig === null) {
          this.groupCache.note(key, key ? this.groupCache.reason : 'leaf')
          return null
        }
        keep[k] = { sig, place: this.groupCache.lastPlace }
        const kept = this.groupCache.get(key, sig)
        if (kept) {
          return kept
        }
        this.groupCache.note(key, this.groupCache.reason)
        return this.groupCache.steady(key, sig) ? 'render' : null
      })
      const inAtlas = leaves.map((_, k) => Boolean(packed?.at[k]) && !own[k])
      const shared = inAtlas.filter(Boolean).length
      for (let k = 0; k < leaves.length; k++) {
        const l = leaves[k] as (typeof leaves)[number]
        const o = own[k]
        if (o && o !== 'render') {
          const child = this.finishGroup(l.m, o, 0, 0, slot++, ctx)
          child.group = l.group
          plan.set(l.i, child)
          continue
        }
        if (shared > 1 && inAtlas[k]) {
          continue
        }
        const child = this.finishGroup(
          l.m,
          this.composite.acquire(l.m.w, l.m.h),
          0,
          0,
          slot++,
          ctx
        )
        child.group = l.group
        plan.set(l.i, child)
        groupPasses++
        drawRange(
          this.beginPass(encoder, child, 'clear', 'group'),
          child,
          l.i + 1,
          l.j,
          'group'
        ).end()
        const lg = scene.groups[l.group]
        const key = lg ? this.groupCache.keyOf(lg) : undefined
        const kk = keep[k]
        // Rendered on its own anyway (or steady): keep it.
        if (key && kk && child.pooled) {
          this.groupCache.put(key, kk.sig, child.pooled, kk.place)
        }
      }
      if (!packed || shared < 2) {
        return
      }
      const atlas = this.composite.acquireShared(packed.w, packed.h, shared)
      groupPasses++
      const rp = encoder.beginRenderPass({
        ...timed(this.shared.timer, 'group'),
        colorAttachments: [
          {
            view: atlas.view,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store'
          }
        ]
      })
      for (let k = 0; k < leaves.length; k++) {
        const l = leaves[k] as (typeof leaves)[number]
        const at = packed.at[k]
        if (!at || !inAtlas[k]) {
          continue
        }
        const child = this.finishGroup(l.m, atlas, at[0], at[1], slot++, ctx)
        child.group = l.group
        plan.set(l.i, child)
        rp.setBindGroup(0, child.bindGroup)
        this.restoreScissor(rp, child)
        drawRange(rp, child, l.i + 1, l.j, 'group')
      }
      rp.end()
    }

    if (this.transforms.size > 0) {
      this.growExtents(scene.groups, ctx, xfs, extents)
    }
    // Groups reaching the band, the extra rows or the strip get textures.
    let reach = band
    for (const r of [...extra, ...(strip ? [strip] : [])]) {
      reach = reach ? hullRows(reach, r) : reach
    }
    main.scissor = reach
    renderLevel(planLevel(main, 0, list.length, planInput), main)
    this.scaleSettling = stepped
    main.scissor = band
    const first = this.beginPass(encoder, main, mainLoad, 'main')
    if (mainLoad === 'load') {
      // Kept pixels outside the band stay; the band is redrawn from clear,
      // and rows a re-anchor newly covered are cleared until drawn.
      this.clearRect ??= new ClearRect(this.shared)
      if (cleared) {
        first.setScissorRect(0, cleared[0], main.devW, cleared[1] - cleared[0])
        this.clearRect.draw(first)
        this.restoreScissor(first, main)
      }
      this.clearRect.draw(first)
    }
    let rp = drawRange(first, main, 0, list.length, 'main')
    for (const r of extra) {
      main.scissor = r
      this.restoreScissor(rp, main)
      this.clearRect?.draw(rp)
      if (culled) {
        culled = this.rowRuns(scene, ctx, main, r)
      }
      rp = drawRange(rp, main, 0, list.length, 'main')
    }
    if (extra.length > 0) {
      main.scissor = band
      this.restoreScissor(rp, main)
    }
    if (strip) {
      // The next strip of pending rows: the same batches again under its
      // scissor.
      main.scissor = strip
      this.restoreScissor(rp, main)
      this.clearRect?.draw(rp)
      if (culled) {
        culled = this.stripRuns(scene, ctx, main, strip)
      }
      rp = drawRange(rp, main, 0, list.length, 'main')
      main.scissor = band
    }
    this.lastCullMs = this.culler.takeMs()
    this.lastBatches = batches
    this.lastGroups = groups
    this.lastGroupPasses = groupPasses
    this.lastDraws = draws
    this.lastInstances = instances
    rp.end()
    if (this.kept && this.keptView && main.view === this.keptView) {
      const scene = chain ? this.sceneTexture : null
      if (scene) {
        // The post chain reads its own scene texture (kept as-is on
        // frames that only rerun the chain).
        encoder.copyTextureToTexture(
          { texture: this.kept },
          { texture: scene },
          { width: scene.width, height: scene.height }
        )
      } else {
        this.copy ??= new CopyThrough(this.shared)
        const cp = this.beginPassOn(encoder, canvasView, 'copy')
        this.copy.draw(cp, this.keptView)
        cp.end()
      }
    }
    if (chain && this.sceneView) {
      this.runPost(chain, encoder, canvasView, texture, ctx, dpr)
      this.sceneKey = key
      this.sceneBatches = scene.batches
    }
    this.composite.flush()
    this.backdrop?.flush()
    this.lastGroupHits = this.groupCache.hits
    this.lastGroupMisses = this.groupCache.misses
    this.lastGroupWhy = this.groupCache.why
    this.lastGroupRendered = this.groupCache.rendered
    this.groupCache.sweep()
    const readback = timer?.end(encoder)
    this.device.queue.submit([encoder.finish()])
    readback?.()
    this.lastEncodeMs = performance.now() - encodeStart
  }

  /** A frame whose scene is unchanged: only the post chain and the canvas
   * pass run, reading the scene texture the last full render left. */
  private renderPostOnly(
    chain: PostChain,
    texture: GPUTexture,
    ctx: FrameContext,
    dpr: number
  ): void {
    this.writeFrame(ctx, dpr)
    this.shared.dpr = dpr
    this.lastUploads = 0
    this.lastUploadMs = 0
    this.lastUploadByLayer = {}
    this.lastBatches = 0
    this.lastGroups = 0
    this.lastGroupWhy = {}
    this.lastGroupRendered = []
    this.lastDraws = 0
    this.lastReused = true
    const encodeStart = performance.now()
    const timer = this.shared.timer
    this.frames++
    timer?.begin(this.frames)
    const encoder = this.device.createCommandEncoder()
    const canvasView = texture.createView({ format: this.gpu.viewFormat })
    this.runPost(chain, encoder, canvasView, texture, ctx, dpr)
    const readback = timer?.end(encoder)
    this.device.queue.submit([encoder.finish()])
    readback?.()
    this.lastEncodeMs = performance.now() - encodeStart
  }

  /** The offscreen scene texture for the post path, re-created when the
   * canvas size changes. */
  private sceneTarget(canvas: GPUTexture): GPUTextureView {
    const t = this.sceneTexture
    if (t && t.width === canvas.width && t.height === canvas.height) {
      return this.sceneView ?? t.createView()
    }
    this.releaseScene()
    const texture = this.device.createTexture({
      label: 'post-scene',
      size: { width: canvas.width, height: canvas.height },
      format: this.shared.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST
    })
    this.sceneTexture = texture
    this.sceneView = texture.createView()
    return this.sceneView
  }

  /** Make the kept texture this frame's size and carry out the plan's
   * shift: its pixels move down `plan.shift` rows (copied into the spare
   * texture, which then swaps in). */
  private keepTexture(
    encoder: GPUCommandEncoder,
    canvas: GPUTexture,
    plan: DrawPlan
  ): void {
    const { width: w, height: h } = canvas
    const make = (label: string): GPUTexture =>
      this.device.createTexture({
        label,
        size: { width: w, height: h },
        format: this.shared.format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST
      })
    if (this.kept?.width !== w || this.kept.height !== h) {
      this.releaseTextures()
      this.kept = make('kept')
      this.keptView = this.kept.createView()
    }
    const r = plan.shift
    if (r === 0 || !this.kept) {
      return
    }
    if (this.keptSpare?.width !== w || this.keptSpare.height !== h) {
      this.keptSpare?.destroy()
      this.keptSpare = make('kept-spare')
    }
    encoder.copyTextureToTexture(
      { texture: this.kept, origin: { x: 0, y: Math.max(0, -r) } },
      { texture: this.keptSpare, origin: { x: 0, y: Math.max(0, r) } },
      { width: w, height: h - Math.abs(r) }
    )
    const spare = this.kept
    this.kept = this.keptSpare
    this.keptSpare = spare
    this.keptView = this.kept.createView()
    this.copy?.release()
  }

  /** Drop the kept texture and the planner's rows for it. */
  private releaseKept(): void {
    this.planner.release()
    this.releaseTextures()
  }

  private releaseTextures(): void {
    this.kept?.destroy()
    this.keptSpare?.destroy()
    this.kept = null
    this.keptSpare = null
    this.keptView = null
    this.copy?.release()
  }

  private releaseScene(): void {
    this.sceneKey = null
    this.sceneBatches = null
    this.sceneTexture?.destroy()
    this.sceneTexture = null
    this.sceneView = null
    this.copy?.release()
  }

  /**
   * The post path's tail: let the chain record its offscreen stages, then
   * one canvas pass that copies the scene through and has the chain's last
   * stage overwrite the visible viewport grown by the chain's radius.
   */
  private runPost(
    chain: PostChain,
    encoder: GPUCommandEncoder,
    canvasView: GPUTextureView,
    texture: GPUTexture,
    ctx: FrameContext,
    dpr: number
  ): void {
    const scene = this.sceneView
    if (!scene) {
      return
    }
    const W = texture.width
    const H = texture.height
    const sx = ctx.canvasWidth > 0 ? W / ctx.canvasWidth : dpr
    const sy = ctx.canvasHeight > 0 ? H / ctx.canvasHeight : dpr
    const span = (a: number, b: number, s: number, max: number): number[] => [
      clamp(Math.floor(a * s), max),
      clamp(Math.ceil(b * s), max)
    ]
    const [vx0 = 0, vx1 = 0] = span(
      ctx.scrollX - ctx.canvasX,
      ctx.scrollX - ctx.canvasX + ctx.width,
      sx,
      W
    )
    const [vy0 = 0, vy1 = 0] = span(
      ctx.scrollY - ctx.canvasY,
      ctx.scrollY - ctx.canvasY + ctx.height,
      sy,
      H
    )
    const viewport: DeviceRect = {
      x: vx0,
      y: vy0,
      width: vx1 - vx0,
      height: vy1 - vy0
    }
    const r = Math.max(0, chain.radius())
    const rx = Math.ceil(r * sx)
    const ry = Math.ceil(r * sy)
    const x0 = clamp(vx0 - rx, W)
    const y0 = clamp(vy0 - ry, H)
    const rect: DeviceRect = {
      x: x0,
      y: y0,
      width: clamp(vx1 + rx, W) - x0,
      height: clamp(vy1 + ry, H) - y0
    }
    const frame: PostFrame = {
      encoder,
      scene,
      sceneWidth: W,
      sceneHeight: H,
      viewport,
      rect,
      ctx,
      dpr
    }
    const live = viewport.width > 0 && viewport.height > 0
    if (live) {
      chain.encode(frame)
    }
    this.copy ??= new CopyThrough(this.shared)
    const rp = this.beginPassOn(encoder, canvasView)
    if (live) {
      // The chain overwrites `rect`: copy the scene through only around
      // it (up to four bands).
      const bands: [number, number, number, number][] = [
        [0, 0, W, rect.y],
        [0, rect.y + rect.height, W, H - rect.y - rect.height],
        [0, rect.y, rect.x, rect.height],
        [rect.x + rect.width, rect.y, W - rect.x - rect.width, rect.height]
      ]
      for (const [x, y, w, h] of bands) {
        if (w > 0 && h > 0) {
          rp.setScissorRect(x, y, w, h)
          this.copy.draw(rp, scene)
        }
      }
      rp.setScissorRect(rect.x, rect.y, rect.width, rect.height)
      chain.composite(rp, frame)
    } else {
      this.copy.draw(rp, scene)
    }
    rp.end()
  }

  private beginPassOn(
    encoder: GPUCommandEncoder,
    view: GPUTextureView,
    label = 'post'
  ): GPURenderPassEncoder {
    const rp = encoder.beginRenderPass({
      ...timed(this.shared.timer, label),
      colorAttachments: [
        {
          view,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    })
    rp.setBindGroup(0, this.shared.frameBindGroup)
    return rp
  }

  /**
   * Allocate the offscreen target for `g` inside `parent`: the group's
   * bounds (padded 1 CSS px for AA fringes) clipped to the parent target
   * and snapped to its device pixels, so the composite is texel-exact.
   * Null when the clipped region is empty.
   */
  /** extents[i]: group i's extent unioned with where its transformed
   * descendants land (groups are sorted by `first`, parents first). */
  private growExtents(
    groups: readonly OpacityGroup[],
    ctx: FrameContext,
    xfs: readonly (Affine | null)[],
    extents: (Box4 | null)[]
  ): void {
    const parentOf: number[] = []
    const stack: number[] = []
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i] as OpacityGroup
      while (stack.length > 0) {
        const top = groups[stack[stack.length - 1] as number] as OpacityGroup
        if (g.first < top.last) {
          break
        }
        stack.pop()
      }
      parentOf[i] = stack.length > 0 ? (stack[stack.length - 1] as number) : -1
      stack.push(i)
      extents[i] = groupExtent(g, ctx)
    }
    for (let i = groups.length - 1; i >= 0; i--) {
      const e = extents[i]
      const p = parentOf[i] ?? -1
      if (!e || p < 0) {
        continue
      }
      const m = xfs[i]
      const out = m ? mapRect(m, e[0], e[1], e[2], e[3]) : e
      const pe = extents[p]
      extents[p] = pe
        ? [
            Math.min(pe[0], out[0]),
            Math.min(pe[1], out[1]),
            Math.max(pe[2], out[2]),
            Math.max(pe[3], out[3])
          ]
        : [...out]
    }
  }

  /** The handler's view of a rendered region group. */
  private regionFrame(
    top: Target,
    parent: Target,
    g: OpacityGroup | undefined,
    encoder: GPUCommandEncoder,
    ctx: FrameContext,
    dpr: number
  ): RegionFrame {
    const pooled = top.pooled as GroupTarget
    return {
      encoder,
      source: pooled.view,
      sourceWidth: pooled.width,
      sourceHeight: pooled.height,
      x: top.px,
      y: top.py,
      width: top.w,
      height: top.h,
      parentX: parent.ox,
      parentY: parent.oy,
      scale: parent.sx,
      alpha: g?.alpha ?? 1,
      ctx,
      dpr
    }
  }

  /** Draw rendered group `top` into its parent's open pass `rp`: through
   * its region handler, or as a quad (through its layer transform).
   * False when nothing was drawn. */
  private compositeGroup(
    rp: GPURenderPassEncoder,
    top: Target,
    parent: Target,
    g: OpacityGroup | undefined,
    ctx: FrameContext
  ): boolean {
    const pooled = top.pooled
    if (!pooled) {
      return false
    }
    const e = this.fx?.effectOf(g) ?? null
    const region = e?.kind === 'region' ? e.region : undefined
    if (top.region && region) {
      const r = meet(
        [top.px, top.py, top.w, top.h],
        parent.scissor ?? [0, 0, parent.devW, parent.devH]
      )
      if (r[2] > 0 && r[3] > 0) {
        rp.setScissorRect(...r)
        region.composite(rp, top.region)
      }
      this.restoreScissor(rp, parent)
      this.composite.release(pooled)
      return true
    }
    const alpha = g?.alpha ?? 1
    const t =
      g?.region !== undefined ? this.transforms.get(g.region) : undefined
    const a = t ? alpha * layerAlpha(t) : alpha
    const [x0, y0, x1, y1] = top.rect
    let quad = rectQuad(top.rect)
    if (top.xf) {
      const m = top.xf
      quad = [
        ...apply(m, x0, y0),
        ...apply(m, x1, y0),
        ...apply(m, x0, y1),
        ...apply(m, x1, y1)
      ]
      // Without rotation the texture maps about 1:1 onto the parent's
      // pixels (rendered at the transform's scale): snap its corner to
      // the parent's pixel grid, or every texel lands between two pixels
      // and the result blurs. Moves it by under a device pixel.
      if (Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6) {
        const qx = ((quad[0] ?? 0) - parent.ox) * parent.sx
        const qy = ((quad[1] ?? 0) - parent.oy) * parent.sy
        const dx = (Math.round(qx) - qx) / parent.sx
        const dy = (Math.round(qy) - qy) / parent.sy
        quad = quad.map((v, i) => v + (i % 2 === 0 ? dx : dy))
      }
    }
    // Moved content stays inside the clips of the element's ancestors
    // (its own records were clipped in the group).
    const sc = top.xf && g ? this.clipScissor(g, parent, ctx) : null
    if (sc && (sc[2] <= 0 || sc[3] <= 0)) {
      this.composite.release(pooled)
      return false
    }
    if (sc && parent.scissor) {
      const r = meet(sc, parent.scissor)
      if (r[2] <= 0 || r[3] <= 0) {
        this.composite.release(pooled)
        return false
      }
      rp.setScissorRect(...r)
    } else if (sc) {
      rp.setScissorRect(sc[0], sc[1], sc[2], sc[3])
    }
    // Inside a rounded/rotated ancestor clip (doc-space groups; the
    // scissor above covers its AABB).
    const shape =
      top.xf && g && g.space !== 'viewport' ? this.clipIndexOf(g.clip) : 0
    this.composite.draw(
      rp,
      pooled,
      quad,
      top.w,
      top.h,
      a,
      shape,
      g?.filter?.matrices,
      top.uv0,
      g?.blend
    )
    if (sc) {
      this.restoreScissor(rp, parent)
    }
    return true
  }

  /** Replace `child`'s texture with its contents blurred by `sigma` CSS
   * px (two passes through pooled targets). */
  private blurGroup(
    encoder: GPUCommandEncoder,
    child: Target,
    sigma: number
  ): void {
    const src = child.pooled
    if (!src) {
      return
    }
    this.groupBlur ??= new GroupBlur(this.shared)
    const blur = this.groupBlur
    // Device px: the group's texture scale (above 1 under a scaling
    // layer transform).
    const s = sigma * Math.max(child.sx, child.sy)
    // Wide blurs at a fraction of the resolution (group_blur.ts).
    const d = downFactor(s)
    const mid = this.composite.acquire(
      Math.ceil(child.w / d),
      Math.ceil(child.h / d)
    )
    blur.run(encoder, src, mid, child.w, child.h, [1, 0], s, { down: d })
    this.composite.release(src)
    const out = this.composite.acquire(child.w, child.h)
    blur.run(encoder, mid, out, child.w, child.h, [0, 1], s, { up: d })
    this.composite.release(mid)
    child.pooled = out
    child.view = out.view
  }

  /** The main target's culled runs for the canvas region, or the band
   * with canvasFill 'band' (cull.ts caches them). */
  private cullFor(scene: Scene, ctx: FrameContext): Runs {
    const band = this.cullDraws === 'canvas' ? null : this.bandY
    const x0 = ctx.canvasX
    const y0 = band ? band[0] : ctx.canvasY
    return this.culler.canvas(
      scene,
      [x0, y0, x0 + ctx.canvasWidth, band ? band[1] : y0 + ctx.canvasHeight],
      [ctx.canvasWidth / 2, (band ? ctx.height : ctx.canvasHeight) / 2]
    )
  }

  /** The main target's runs culled to the rows of `r` (device px of `t`). */
  private rowRuns(
    scene: Scene,
    ctx: FrameContext,
    t: Target,
    r: readonly [number, number, number, number]
  ): Runs {
    return this.culler.rows(
      scene,
      ctx.canvasX,
      ctx.canvasX + ctx.canvasWidth,
      r[1] / t.sy + t.oy,
      (r[1] + r[3]) / t.sy + t.oy
    )
  }

  /** The main target's runs culled to `strip` (device rows of `t`) and
   * the pending interval it came from (`stripFrom`). */
  private stripRuns(
    scene: Scene,
    ctx: FrameContext,
    t: Target,
    strip: readonly [number, number, number, number]
  ): Runs {
    const p = this.stripFrom
    return this.culler.strip(
      scene,
      ctx.canvasX,
      ctx.canvasX + ctx.canvasWidth,
      strip[1] / t.sy + t.oy,
      (strip[1] + strip[3]) / t.sy + t.oy,
      p ? [p[0] / t.sy + t.oy, p[1] / t.sy + t.oy] : null
    )
  }

  /** End `rp`, filter what `target` holds under `rec` into a pooled
   * texture (blurred around the border box by 3σ), begin a new pass on
   * `target` and draw it there inside the element's shape. */
  private drawBackdrop(
    encoder: GPUCommandEncoder,
    rp: GPURenderPassEncoder,
    target: Target,
    rec: BackdropRecord,
    ctx: FrameContext,
    label: string
  ): GPURenderPassEncoder {
    const vx = rec.space === 'viewport' ? ctx.scrollX : 0
    const vy = rec.space === 'viewport' ? ctx.scrollY : 0
    const r = rec.rect
    const pad = rec.filter.blur * 3 + 1
    const x0 = clamp(
      Math.floor((r.x + vx - pad - target.ox) * target.sx),
      target.devW
    )
    const y0 = clamp(
      Math.floor((r.y + vy - pad - target.oy) * target.sy),
      target.devH
    )
    const x1 = clamp(
      Math.ceil((r.x + r.width + vx + pad - target.ox) * target.sx),
      target.devW
    )
    const y1 = clamp(
      Math.ceil((r.y + r.height + vy + pad - target.oy) * target.sy),
      target.devH
    )
    const w = x1 - x0
    const h = y1 - y0
    const backdrop = this.backdrop
    if (w <= 0 || h <= 0 || !backdrop) {
      return rp
    }
    rp.end()
    this.groupBlur ??= new GroupBlur(this.shared)
    const blur = this.groupBlur
    // The target as a blur source (its pass has ended).
    const src = {
      view: target.view,
      width: target.pooled?.width ?? target.devW,
      height: target.pooled?.height ?? target.devH
    }
    const s = rec.filter.blur * Math.max(target.sx, target.sy)
    // First pass: the region, shifted to the texture's origin (and
    // blurred across); second: blurred down.
    const d = s >= 0.01 ? downFactor(s) : 1
    let out = this.composite.acquire(Math.ceil(w / d), Math.ceil(h / d))
    blur.run(encoder, src, out, w, h, [1, 0], s, {
      offset: [-x0, -y0],
      down: d
    })
    if (s >= 0.01) {
      const mid = out
      out = this.composite.acquire(w, h)
      blur.run(encoder, mid, out, w, h, [0, 1], s, { up: d })
      this.composite.release(mid)
    }
    const next = this.beginPass(encoder, target, 'load', label)
    backdrop.draw(next, out, rec, x0, y0, this.clipIndexOf(rec.clip))
    this.composite.release(out)
    return next
  }

  /** Replace `child`'s texture with its contents over `sh`, their
   * drop shadow (two passes through pooled targets). */
  private shadowGroup(
    encoder: GPUCommandEncoder,
    child: Target,
    sh: DropShadow
  ): void {
    const src = child.pooled
    if (!src) {
      return
    }
    this.groupBlur ??= new GroupBlur(this.shared)
    const blur = this.groupBlur
    const s = sh.sigma * Math.max(child.sx, child.sy)
    const [r, g, b, a] = sh.color
    const d = downFactor(s)
    const mid = this.composite.acquire(
      Math.ceil(child.w / d),
      Math.ceil(child.h / d)
    )
    blur.run(encoder, src, mid, child.w, child.h, [1, 0], s, {
      offset: [sh.dx * child.sx, sh.dy * child.sy],
      down: d
    })
    const out = this.composite.acquire(child.w, child.h)
    blur.run(encoder, mid, out, child.w, child.h, [0, 1], s, {
      shadow: { tint: [r * a, g * a, b * a, a], orig: src },
      up: d
    })
    this.composite.release(mid)
    this.composite.release(src)
    child.pooled = out
    child.view = out.view
  }

  /** The parent-target scissor (x, y, w, h device px) for `g`'s
   * ancestors' clip, or null when it has none. */
  private clipScissor(
    g: OpacityGroup,
    parent: Target,
    ctx: FrameContext
  ): [number, number, number, number] | null {
    const c = g.clip
    if (!c) {
      return null
    }
    const vx = g.space === 'viewport' ? ctx.scrollX : 0
    const vy = g.space === 'viewport' ? ctx.scrollY : 0
    const x0 = clamp(
      Math.floor((c.x + vx - parent.ox) * parent.sx),
      parent.devW
    )
    const y0 = clamp(
      Math.floor((c.y + vy - parent.oy) * parent.sy),
      parent.devH
    )
    const x1 = clamp(
      Math.ceil((c.x + vx + c.width - parent.ox) * parent.sx),
      parent.devW
    )
    const y1 = clamp(
      Math.ceil((c.y + vy + c.height - parent.oy) * parent.sy),
      parent.devH
    )
    return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)]
  }

  /** The target for a measured group drawn from device px (ax, ay) of
   * `pooled` (a texture of its own: 0, 0; a group atlas: its rect). */
  private finishGroup(
    m: GroupPlace,
    pooled: GroupTarget,
    ax: number,
    ay: number,
    slot: number,
    ctx: FrameContext
  ): Target {
    const { w, h, sx, sy, ox, oy, kx, ky } = m
    // The frame maps the texture's origin, (ax, ay) device px before the
    // group's own.
    const tx = ox - ax / sx
    const ty = oy - ay / sy
    const frame = this.groupFrame(slot)
    const f = this.frameData
    f[0] = pooled.width / sx
    f[1] = pooled.height / sy
    f[2] = tx
    f[3] = ty
    f[4] = ctx.time
    // Device px per CSS px in this target (Slug's AA pad reads it).
    f[5] = this.shared.dpr * Math.max(kx, ky)
    // The target origin in viewport space, for viewport-space records: doc
    // origin minus the real scroll (not the parent's origin, which is the
    // canvas anchor on the main target).
    f[6] = tx - ctx.scrollX
    f[7] = ty - ctx.scrollY
    this.device.queue.writeBuffer(frame.buffer, 0, f)
    const t: Target = {
      view: pooled.view,
      bindGroup: frame.bindGroup,
      ox: tx,
      oy: ty,
      devW: pooled.width,
      devH: pooled.height,
      sx,
      sy,
      group: -1,
      pooled,
      rect: [ox, oy, ox + w / sx, oy + h / sy],
      w,
      h,
      px: m.px,
      py: m.py,
      xf: m.xf
    }
    if (pooled.refs !== undefined) {
      t.uv0 = [ax, ay]
      t.scissor = [ax, ay, w, h]
    }
    return t
  }

  /** Time render passes on the GPU (needs `timestamp-query`); results
   * reach `onResult` a frame or two later. Returns whether timing runs. */
  setGpuTiming(onResult: ((t: GpuFrameTiming) => void) | null): boolean {
    this.shared.timer?.destroy()
    this.shared.timer = null
    if (onResult && GpuTimer.supported(this.device)) {
      this.shared.timer = new GpuTimer(this.device, onResult)
    }
    return this.shared.timer !== null
  }

  /** GPU timing readbacks still in flight. */
  get gpuTimingPending(): number {
    return this.shared.timer?.pending ?? 0
  }

  destroy(): void {
    this.setGpuTiming(null)
    this.groupBlur?.destroy()
    this.backdrop?.destroy()
    for (const pass of this.passes) {
      pass.destroy()
    }
    this.frameBuffer.destroy()
    this.clipBuffer.destroy()
    for (const f of this.groupFrames) {
      f.buffer.destroy()
    }
    this.groupCache.clear()
    this.composite.destroy()
    this.releaseScene()
    this.releaseKept()
  }
}
