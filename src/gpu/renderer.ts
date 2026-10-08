import type { DrawBatch } from '../scene/batches'
import type { Scene } from '../scene/scene'
import type { OpacityGroup } from '../scene/stacking'
import type { FrameContext, Layer } from '../types'
import { GroupCompositor, type GroupTarget, rectQuad } from './composite'
import type { GpuContext } from './device'
import { FRAME_BYTES, type RenderPass, type Shared } from './frame'
import {
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
}

function clamp(v: number, max: number): number {
  return Math.min(Math.max(v, 0), max)
}

/** A doc-space affine [a, b, c, d, e, f]: (x, y) -> (a x + c y + e,
 * b x + d y + f). */
type Affine = readonly [number, number, number, number, number, number]

function apply(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

function invert(m: Affine): Affine | null {
  const det = m[0] * m[3] - m[1] * m[2]
  if (Math.abs(det) < 1e-9) {
    return null
  }
  const a = m[3] / det
  const b = -m[1] / det
  const c = -m[2] / det
  const d = m[0] / det
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])]
}

/** `t` as a doc-space affine about its origin in the group's box, or null
 * when it is the identity (or the group has no box). */
function layerAffine(
  g: OpacityGroup,
  t: LayerTransform,
  ctx: FrameContext
): Affine | null {
  const sx = Number.isFinite(t.scaleX) ? t.scaleX : 1
  const sy = Number.isFinite(t.scaleY) ? t.scaleY : 1
  const rot = Number.isFinite(t.rotate) ? t.rotate : 0
  const tx = Number.isFinite(t.x) ? t.x : 0
  const ty = Number.isFinite(t.y) ? t.y : 0
  if (tx === 0 && ty === 0 && sx === 1 && sy === 1 && rot % 360 === 0) {
    return null
  }
  const box = g.box
  if (!box) {
    return null
  }
  const vx = g.space === 'viewport' ? ctx.scrollX : 0
  const vy = g.space === 'viewport' ? ctx.scrollY : 0
  const ox =
    box.x + vx + (Number.isFinite(t.originX) ? t.originX : 0.5) * box.width
  const oy =
    box.y + vy + (Number.isFinite(t.originY) ? t.originY : 0.5) * box.height
  const r = (rot * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const a = cos * sx
  const b = sin * sx
  const c = -sin * sy
  const d = cos * sy
  return [a, b, c, d, ox + tx - (a * ox + c * oy), oy + ty - (b * ox + d * oy)]
}

type Box4 = [number, number, number, number]

/** Resolution bounds for a transformed group's texture, relative to its
 * parent's: rendered at the transform's own scale (as a browser
 * re-rasters a scaled layer), so text and edges stay crisp scaled down or
 * up and the composite samples about 1:1. */
const MIN_RES = 1 / 16
const MAX_RES = 4

/** `m`'s axis scales (the lengths the unit x and y axes map to), clamped
 * to [MIN_RES, MAX_RES]. */
function axisScales(m: Affine): [number, number] {
  const c = (v: number) => Math.min(MAX_RES, Math.max(MIN_RES, v))
  return [c(Math.hypot(m[0], m[1])), c(Math.hypot(m[2], m[3]))]
}

/** A layer transform's opacity in [0, 1] (1 when not a number). */
function layerAlpha(t: LayerTransform): number {
  return Number.isFinite(t.opacity) ? Math.min(1, Math.max(0, t.opacity)) : 1
}

/** `g`'s doc-space extent at the current scroll (viewport-space members
 * at their viewport rect + scroll), or null when empty. */
function groupExtent(g: OpacityGroup, ctx: FrameContext): Box4 | null {
  let bx0 = Number.POSITIVE_INFINITY
  let by0 = Number.POSITIVE_INFINITY
  let bx1 = Number.NEGATIVE_INFINITY
  let by1 = Number.NEGATIVE_INFINITY
  const d = g.bounds
  if (d.width > 0 && d.height > 0) {
    bx0 = d.x
    by0 = d.y
    bx1 = d.x + d.width
    by1 = d.y + d.height
  }
  const v = g.vbounds
  if (v) {
    bx0 = Math.min(bx0, v.x + ctx.scrollX)
    by0 = Math.min(by0, v.y + ctx.scrollY)
    bx1 = Math.max(bx1, v.x + v.width + ctx.scrollX)
    by1 = Math.max(by1, v.y + v.height + ctx.scrollY)
  }
  return bx1 > bx0 && by1 > by0 ? [bx0, by0, bx1, by1] : null
}

/** AABB of `m` applied to the rect (x0, y0)-(x1, y1). */
function mapRect(
  m: Affine,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): [number, number, number, number] {
  const p = [
    apply(m, x0, y0),
    apply(m, x1, y0),
    apply(m, x0, y1),
    apply(m, x1, y1)
  ]
  return [
    Math.min(...p.map((q) => q[0])),
    Math.min(...p.map((q) => q[1])),
    Math.max(...p.map((q) => q[0])),
    Math.max(...p.map((q) => q[1]))
  ]
}

/** Index of the pop matching the push of `group` at `i`. */
function skipGroup(
  list: readonly DrawBatch[],
  i: number,
  group: number
): number {
  for (let j = i + 1; j < list.length; j++) {
    const b = list[j]
    if (b && b.kind === 'pop' && b.group === group) {
      return j
    }
  }
  return list.length
}

/**
 * Owns the shared frame uniforms and drives the per-frame render: update
 * uniforms, (re-)upload dirty passes, walk the batch list (one render pass
 * per target segment; see render()), submit.
 */
export class Renderer {
  private readonly device: GPUDevice
  private readonly frameBuffer: GPUBuffer
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
  /** Wall time spent in pass uploads in the most recent render, ms. */
  lastUploadMs = 0
  /** Wall time from createCommandEncoder to submit in the most recent
   * render, ms. */
  lastEncodeMs = 0
  private readonly composite: GroupCompositor
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
  private copy: CopyThrough | null = null

  constructor(private readonly gpu: GpuContext) {
    this.device = gpu.device
    this.frameBuffer = this.device.createBuffer({
      size: FRAME_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    const frameLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' }
        }
      ]
    })
    const frameBindGroup = this.device.createBindGroup({
      layout: frameLayout,
      entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }]
    })
    this.shared = {
      device: this.device,
      format: gpu.viewFormat,
      frameLayout,
      frameBindGroup,
      dpr: 1
    }
    this.composite = new GroupCompositor(this.shared)
  }

  /** Forget material `id`'s cached pipelines in every pass. */
  dropMaterial(id: number): void {
    this.materials.delete(id)
    for (const pass of this.passes) {
      pass.dropMaterial?.(id)
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
        entries: [{ binding: 0, resource: { buffer } }]
      })
      f = { buffer, bindGroup }
      this.groupFrames[slot] = f
    }
    return f
  }

  private beginPass(
    encoder: GPUCommandEncoder,
    t: Target,
    loadOp: GPULoadOp
  ): GPURenderPassEncoder {
    const rp = encoder.beginRenderPass({
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
    return rp
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
    this.writeFrame(ctx, dpr)
    this.shared.dpr = dpr
    // Upload only the layers that changed since they were last drawn.
    let uploads = 0
    let uploadMs = 0
    for (const pass of this.passes) {
      if (scene.isDirty(pass.layer)) {
        const t0 = performance.now()
        pass.upload(scene)
        uploadMs += performance.now() - t0
        scene.clearDirty(pass.layer)
        uploads++
      }
    }
    this.lastUploads = uploads
    this.lastUploadMs = uploadMs
    const encodeStart = performance.now()
    const encoder = this.device.createCommandEncoder()
    const texture = this.gpu.context.getCurrentTexture()
    const canvasView = texture.createView({ format: this.gpu.viewFormat })
    const chain = this.postChain?.active() ? this.postChain : null
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
    this.composite.begin(scene.groups.length)
    let batches = 0
    let groups = 0
    let draws = 0
    let slot = 0
    const list = scene.batches
    // Two phases. Every group's texture is rendered first (children before
    // parents, each in its own pass), then each target's pass draws its
    // batches and composites its child groups in place. A target's pass is
    // never split, so groups cost no reload of their parent (the main
    // target is the whole canvas).
    /** By push index: a rendered group, or 'in-place' (drawn in its
     * parent's pass), or 'skip' (nothing to draw). */
    const plan = new Map<number, Target | 'in-place' | 'skip'>()
    // Layer transforms by group, and extents grown by transformed
    // descendants (an enclosing group's texture must hold where they land).
    const xfs: (Affine | null)[] = []
    const extents: (Box4 | null)[] = []
    for (let gi = 0; gi < scene.groups.length; gi++) {
      const g = scene.groups[gi]
      const region =
        g?.region !== undefined ? this.regions.get(g.region) : undefined
      const t =
        g?.region !== undefined && !region?.active()
          ? this.transforms.get(g.region)
          : undefined
      xfs[gi] = g && t ? layerAffine(g, t, ctx) : null
    }
    const popOf = (i: number, group: number): number =>
      skipGroup(list, i, group)

    const drawRange = (
      rp: GPURenderPassEncoder,
      target: Target,
      start: number,
      end: number
    ): void => {
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
          const j = popOf(i, batch.group)
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
        } else {
          const pass = this.passByLayer.get(batch.layer)
          if (!pass) {
            continue
          }
          const mat =
            batch.material !== undefined
              ? this.materials.get(batch.material)
              : undefined
          draws += pass.draw(
            rp,
            batch.first,
            batch.count,
            mat?.active() ? mat : null
          )
          batches++
        }
      }
    }

    /** Plan and render the groups in list[start, end) drawn into
     * `parent` (recursing into in-place groups' contents). */
    const prepare = (parent: Target, start: number, end: number): void => {
      for (let i = start; i < end; i++) {
        const batch = list[i]
        if (batch?.kind !== 'push') {
          continue
        }
        const j = popOf(i, batch.group)
        const g = scene.groups[batch.group]
        const region =
          g?.region !== undefined ? this.regions.get(g.region) : undefined
        const pad = region?.active() ? Math.max(0, region.pad()) : 0
        const t =
          g?.region !== undefined && !region?.active()
            ? this.transforms.get(g.region)
            : undefined
        const tAlpha = t ? layerAlpha(t) : 1
        const xf = xfs[batch.group] ?? null
        if (t && g && !xf && tAlpha === 1 && g.alpha === 1) {
          // A layer transform at rest: its records draw in place.
          plan.set(i, 'in-place')
          prepare(parent, i + 1, j)
          i = j
          continue
        }
        const child =
          g && g.alpha * tAlpha > 0
            ? this.openGroup(
                g,
                parent,
                slot,
                ctx,
                pad,
                xf,
                extents[batch.group] ?? groupExtent(g, ctx)
              )
            : null
        if (!child) {
          plan.set(i, 'skip')
          i = j
          continue
        }
        slot++
        child.group = batch.group
        plan.set(i, child)
        prepare(child, i + 1, j)
        const rp = this.beginPass(encoder, child, 'clear')
        drawRange(rp, child, i + 1, j)
        rp.end()
        if (region?.active() && child.pooled) {
          child.region = this.regionFrame(child, parent, g, encoder, ctx, dpr)
          region.encode(child.region)
        }
        i = j
      }
    }

    if (this.transforms.size > 0) {
      this.growExtents(scene.groups, ctx, xfs, extents)
    }
    prepare(main, 0, list.length)
    const rp = this.beginPass(encoder, main, 'clear')
    drawRange(rp, main, 0, list.length)
    this.lastBatches = batches
    this.lastGroups = groups
    this.lastDraws = draws
    rp.end()
    if (chain && this.sceneView) {
      this.runPost(chain, encoder, canvasView, texture, ctx, dpr)
    }
    this.composite.flush()
    this.device.queue.submit([encoder.finish()])
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
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    })
    this.sceneTexture = texture
    this.sceneView = texture.createView()
    return this.sceneView
  }

  private releaseScene(): void {
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
    view: GPUTextureView
  ): GPURenderPassEncoder {
    const rp = encoder.beginRenderPass({
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
    const region =
      g?.region !== undefined ? this.regions.get(g.region) : undefined
    if (top.region && region) {
      rp.setScissorRect(top.px, top.py, top.w, top.h)
      region.composite(rp, top.region)
      rp.setScissorRect(0, 0, parent.devW, parent.devH)
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
    if (sc) {
      rp.setScissorRect(sc[0], sc[1], sc[2], sc[3])
    }
    this.composite.draw(rp, pooled, quad, top.w, top.h, a)
    if (sc) {
      rp.setScissorRect(0, 0, parent.devW, parent.devH)
    }
    return true
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

  private openGroup(
    g: OpacityGroup,
    parent: Target,
    slot: number,
    ctx: FrameContext,
    pad = 0,
    xf: Affine | null = null,
    extent: Box4 | null = groupExtent(g, ctx)
  ): Target | null {
    if (!extent) {
      return null
    }
    const [bx0, by0, bx1, by1] = extent
    const p = 1 + pad
    let x0: number
    let y0: number
    let x1: number
    let y1: number
    const inv = xf ? invert(xf) : null
    if (xf && !inv) {
      // Scaled to nothing: nothing to draw.
      return null
    }
    if (inv) {
      // Under a layer transform: render the part of the group that can
      // land on the parent (its rect mapped back), not the part that sits
      // on it untransformed.
      // The parent's rect, cut to the ancestors' clip the result gets.
      let px0 = parent.ox
      let py0 = parent.oy
      let px1 = parent.ox + parent.devW / parent.sx
      let py1 = parent.oy + parent.devH / parent.sy
      const c = g.clip
      if (c) {
        const vx = g.space === 'viewport' ? ctx.scrollX : 0
        const vy = g.space === 'viewport' ? ctx.scrollY : 0
        px0 = Math.max(px0, c.x + vx)
        py0 = Math.max(py0, c.y + vy)
        px1 = Math.min(px1, c.x + vx + c.width)
        py1 = Math.min(py1, c.y + vy + c.height)
        if (px1 <= px0 || py1 <= py0) {
          return null
        }
      }
      const [ix0, iy0, ix1, iy1] = mapRect(inv, px0, py0, px1, py1)
      const max = this.device.limits.maxTextureDimension2D
      x0 = Math.floor((Math.max(bx0 - p, ix0) - parent.ox) * parent.sx)
      y0 = Math.floor((Math.max(by0 - p, iy0) - parent.oy) * parent.sy)
      x1 = Math.min(
        Math.ceil((Math.min(bx1 + p, ix1) - parent.ox) * parent.sx),
        x0 + max
      )
      y1 = Math.min(
        Math.ceil((Math.min(by1 + p, iy1) - parent.oy) * parent.sy),
        y0 + max
      )
    } else {
      x0 = clamp(Math.floor((bx0 - p - parent.ox) * parent.sx), parent.devW)
      y0 = clamp(Math.floor((by0 - p - parent.oy) * parent.sy), parent.devH)
      x1 = clamp(Math.ceil((bx1 + p - parent.ox) * parent.sx), parent.devW)
      y1 = clamp(Math.ceil((by1 + p - parent.oy) * parent.sy), parent.devH)
    }
    if (x1 <= x0 || y1 <= y0) {
      return null
    }
    // Under a transform the texture is rendered at the transform's scale
    // (k device px per parent device px), within the size limit.
    let kx = 1
    let ky = 1
    if (inv && xf) {
      const max = this.device.limits.maxTextureDimension2D
      ;[kx, ky] = axisScales(xf)
      kx = Math.min(kx, max / (x1 - x0))
      ky = Math.min(ky, max / (y1 - y0))
    }
    const w = Math.max(1, Math.ceil((x1 - x0) * kx))
    const h = Math.max(1, Math.ceil((y1 - y0) * ky))
    const sx = parent.sx * kx
    const sy = parent.sy * ky
    const pooled = this.composite.acquire(w, h)
    const ox = parent.ox + x0 / parent.sx
    const oy = parent.oy + y0 / parent.sy
    const frame = this.groupFrame(slot)
    const f = this.frameData
    f[0] = pooled.width / sx
    f[1] = pooled.height / sy
    f[2] = ox
    f[3] = oy
    f[4] = ctx.time
    // Device px per CSS px in this target (Slug's AA pad reads it).
    f[5] = this.shared.dpr * Math.max(kx, ky)
    // The target origin in viewport space, for viewport-space records: doc
    // origin minus the real scroll (not the parent's origin, which is the
    // canvas anchor on the main target).
    f[6] = ox - ctx.scrollX
    f[7] = oy - ctx.scrollY
    this.device.queue.writeBuffer(frame.buffer, 0, f)
    return {
      view: pooled.view,
      bindGroup: frame.bindGroup,
      ox,
      oy,
      devW: pooled.width,
      devH: pooled.height,
      sx,
      sy,
      group: -1,
      pooled,
      rect: [ox, oy, ox + w / sx, oy + h / sy],
      w,
      h,
      px: x0,
      py: y0,
      xf: inv ? xf : null
    }
  }

  destroy(): void {
    for (const pass of this.passes) {
      pass.destroy()
    }
    this.frameBuffer.destroy()
    for (const f of this.groupFrames) {
      f.buffer.destroy()
    }
    this.composite.destroy()
    this.releaseScene()
  }
}
