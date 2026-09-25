import type { DrawBatch } from '../scene/batches'
import type { Scene } from '../scene/scene'
import type { OpacityGroup } from '../scene/stacking'
import type { FrameContext, Layer } from '../types'
import { GroupCompositor, type GroupTarget } from './composite'
import type { GpuContext } from './device'
import { FRAME_BYTES, type RenderPass, type Shared } from './frame'

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
    const f = this.frameData
    f[0] = ctx.width
    f[1] = ctx.height
    f[2] = ctx.scrollX
    f[3] = ctx.scrollY
    f[4] = ctx.time
    f[5] = dpr
    f[6] = 0
    f[7] = 0
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
   * maps the group's viewport-clipped doc rect onto the texture; the
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
    const main: Target = {
      view: texture.createView({ format: this.gpu.viewFormat }),
      bindGroup: this.shared.frameBindGroup,
      ox: ctx.scrollX,
      oy: ctx.scrollY,
      devW: texture.width,
      devH: texture.height,
      sx: ctx.width > 0 ? texture.width / ctx.width : dpr,
      sy: ctx.height > 0 ? texture.height / ctx.height : dpr,
      group: -1,
      pooled: null,
      rect: [0, 0, 0, 0],
      w: 0,
      h: 0
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
        const child =
          g && g.alpha > 0 ? this.openGroup(g, parent, slot, ctx) : null
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
        rp = this.beginPass(encoder, parent, 'load')
        const alpha = scene.groups[batch.group]?.alpha ?? 1
        this.composite.draw(rp, top.pooled, top.rect, top.w, top.h, alpha)
        groups++
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
    this.composite.flush()
    this.device.queue.submit([encoder.finish()])
    this.lastEncodeMs = performance.now() - encodeStart
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
    ctx: FrameContext
  ): Target | null {
    const b = g.bounds
    const x0 = clamp(Math.floor((b.x - 1 - parent.ox) * parent.sx), parent.devW)
    const y0 = clamp(Math.floor((b.y - 1 - parent.oy) * parent.sy), parent.devH)
    const x1 = clamp(
      Math.ceil((b.x + b.width + 1 - parent.ox) * parent.sx),
      parent.devW
    )
    const y1 = clamp(
      Math.ceil((b.y + b.height + 1 - parent.oy) * parent.sy),
      parent.devH
    )
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
    f[6] = 0
    f[7] = 0
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
      h
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
  }
}
