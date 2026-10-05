import type { DrawBatch } from '../scene/batches'
import type { Scene } from '../scene/scene'
import type { OpacityGroup } from '../scene/stacking'
import type { FrameContext, Layer } from '../types'
import { GroupCompositor, type GroupTarget } from './composite'
import type { GpuContext } from './device'
import { FRAME_BYTES, type RenderPass, type Shared } from './frame'
import {
  CopyThrough,
  type DeviceRect,
  type ExtraLayer,
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
}

function clamp(v: number, max: number): number {
  return Math.min(Math.max(v, 0), max)
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
      py: 0
    }
    this.composite.begin(scene.groups.length)
    const stack: Target[] = [main]
    let rp = this.beginPass(encoder, main, 'clear')
    let batches = 0
    let groups = 0
    let draws = 0
    let slot = 0
    const list = scene.batches
    for (let i = 0; i < list.length; i++) {
      const batch = list[i]
      if (!batch) {
        continue
      }
      if (batch.kind === 'push') {
        const parent = stack[stack.length - 1] ?? main
        const g = scene.groups[batch.group]
        const region =
          g?.region !== undefined ? this.regions.get(g.region) : undefined
        const pad = region?.active() ? Math.max(0, region.pad()) : 0
        const child =
          g && g.alpha > 0 ? this.openGroup(g, parent, slot, ctx, pad) : null
        if (!child) {
          i = skipGroup(list, i, batch.group)
          continue
        }
        slot++
        child.group = batch.group
        rp.end()
        stack.push(child)
        rp = this.beginPass(encoder, child, 'clear')
      } else if (batch.kind === 'pop') {
        const top = stack[stack.length - 1]
        if (!top || top.group !== batch.group || !top.pooled) {
          continue
        }
        rp.end()
        stack.pop()
        const parent = stack[stack.length - 1] ?? main
        const g = scene.groups[batch.group]
        const alpha = g?.alpha ?? 1
        const region =
          g?.region !== undefined ? this.regions.get(g.region) : undefined
        if (region?.active()) {
          const frame: RegionFrame = {
            encoder,
            source: top.pooled.view,
            sourceWidth: top.pooled.width,
            sourceHeight: top.pooled.height,
            x: top.px,
            y: top.py,
            width: top.w,
            height: top.h,
            parentX: parent.ox,
            parentY: parent.oy,
            scale: parent.sx,
            alpha,
            ctx,
            dpr
          }
          region.encode(frame)
          rp = this.beginPass(encoder, parent, 'load')
          rp.setScissorRect(top.px, top.py, top.w, top.h)
          region.composite(rp, frame)
          rp.setScissorRect(0, 0, parent.devW, parent.devH)
          this.composite.release(top.pooled)
        } else {
          rp = this.beginPass(encoder, parent, 'load')
          this.composite.draw(rp, top.pooled, top.rect, top.w, top.h, alpha)
        }
        groups++
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
        draws += pass.draw(rp, batch.first, batch.count)
        batches++
      }
    }
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
  private openGroup(
    g: OpacityGroup,
    parent: Target,
    slot: number,
    ctx: FrameContext,
    pad = 0
  ): Target | null {
    // Doc-space extent at the current scroll: viewport-space members
    // (fixed subtrees) sit at their viewport rect + scroll.
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
    if (!(bx1 > bx0 && by1 > by0)) {
      return null
    }
    const p = 1 + pad
    const x0 = clamp(Math.floor((bx0 - p - parent.ox) * parent.sx), parent.devW)
    const y0 = clamp(Math.floor((by0 - p - parent.oy) * parent.sy), parent.devH)
    const x1 = clamp(Math.ceil((bx1 + p - parent.ox) * parent.sx), parent.devW)
    const y1 = clamp(Math.ceil((by1 + p - parent.oy) * parent.sy), parent.devH)
    const w = x1 - x0
    const h = y1 - y0
    if (w <= 0 || h <= 0) {
      return null
    }
    const pooled = this.composite.acquire(w, h)
    const ox = parent.ox + x0 / parent.sx
    const oy = parent.oy + y0 / parent.sy
    const frame = this.groupFrame(slot)
    const f = this.frameData
    f[0] = pooled.width / parent.sx
    f[1] = pooled.height / parent.sy
    f[2] = ox
    f[3] = oy
    f[4] = ctx.time
    f[5] = this.shared.dpr
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
      sx: parent.sx,
      sy: parent.sy,
      group: -1,
      pooled,
      rect: [ox, oy, ox + w / parent.sx, oy + h / parent.sy],
      w,
      h,
      px: x0,
      py: y0
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
