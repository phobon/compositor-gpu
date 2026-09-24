import type { Scene } from '../scene/scene'
import type { FrameContext, Layer } from '../types'
import type { GpuContext } from './device'
import { FRAME_BYTES, type RenderPass, type Shared } from './frame'

/**
 * Owns the shared frame uniforms and drives the per-frame render: update
 * uniforms, (re-)upload dirty passes, run one render pass, submit.
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
      frameBindGroup
    }
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

  render(scene: Scene, ctx: FrameContext, dpr: number): void {
    this.writeFrame(ctx, dpr)
    // Upload only the layers that changed since they were last drawn.
    let uploads = 0
    for (const pass of this.passes) {
      if (scene.isDirty(pass.layer)) {
        pass.upload(scene)
        scene.clearDirty(pass.layer)
        uploads++
      }
    }
    this.lastUploads = uploads
    const encoder = this.device.createCommandEncoder()
    const view = this.gpu.context
      .getCurrentTexture()
      .createView({ format: this.gpu.viewFormat })
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
    let batches = 0
    for (const batch of scene.batches) {
      const pass = this.passByLayer.get(batch.layer)
      if (!pass) continue
      pass.draw(rp, batch.first, batch.count)
      batches++
    }
    this.lastBatches = batches
    rp.end()
    this.device.queue.submit([encoder.finish()])
  }

  destroy(): void {
    for (const pass of this.passes) pass.destroy()
    this.frameBuffer.destroy()
  }
}
