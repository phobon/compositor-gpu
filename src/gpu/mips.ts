import { reportShaderErrors } from '../util/log'

const BLIT_SHADER = /* wgsl */ `
struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};

@vertex
fn vs_blit(@builtin(vertex_index) vi : u32) -> VOut {
  // Fullscreen triangle: NDC positions that overshoot the viewport, with UV
  // derived from the same positions (flipping y: NDC is y-up, textures are
  // y-down).
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out : VOut;
  let p = pos[vi];
  out.pos = vec4f(p, 0.0, 1.0);
  out.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return out;
}

@group(0) @binding(0) var srcTex : texture_2d<f32>;
@group(0) @binding(1) var srcSamp : sampler;

@fragment
fn fs_blit(in : VOut) -> @location(0) vec4f {
  return textureSample(srcTex, srcSamp, in.uv);
}
`

/** Number of mip levels for a full chain down to 1x1. */
export function mipLevelCountFor(size: number): number {
  return 1 + Math.floor(Math.log2(Math.max(1, size)))
}

/**
 * Lazily-built mip generator shared by every `rgba8unorm` texture that needs
 * a full chain (standalone image textures, the shared image atlas):
 * downsamples level 0 into every level via a fullscreen-triangle blit, one
 * render pass per level.
 */
export class MipGenerator {
  private pipeline: GPURenderPipeline | null = null
  private layout: GPUBindGroupLayout | null = null
  private sampler: GPUSampler | null = null

  constructor(private readonly device: GPUDevice) {}

  private ensure(): void {
    if (this.pipeline) {
      return
    }
    const { device } = this
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }
      ]
    })
    const module = device.createShaderModule({ code: BLIT_SHADER })
    reportShaderErrors(module, 'mip-blit')
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: 'vs_blit' },
      fragment: {
        module,
        entryPoint: 'fs_blit',
        targets: [{ format: 'rgba8unorm' }]
      },
      primitive: { topology: 'triangle-list' }
    })
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear'
    })
  }

  /**
   * Downsample level 0 of `texture` into levels [1, mipLevelCount). Records
   * onto `encoder` when given (caller submits); otherwise creates and
   * submits its own command buffer immediately.
   */
  generate(
    texture: GPUTexture,
    mipLevelCount: number,
    encoder?: GPUCommandEncoder
  ): void {
    if (mipLevelCount <= 1) {
      return
    }
    this.ensure()
    const pipeline = this.pipeline as GPURenderPipeline
    const layout = this.layout as GPUBindGroupLayout
    const sampler = this.sampler as GPUSampler
    const { device } = this
    const enc = encoder ?? device.createCommandEncoder()
    for (let level = 1; level < mipLevelCount; level++) {
      const srcView = texture.createView({
        baseMipLevel: level - 1,
        mipLevelCount: 1
      })
      const dstView = texture.createView({
        baseMipLevel: level,
        mipLevelCount: 1
      })
      const bindGroup = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: sampler }
        ]
      })
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: dstView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 }
          }
        ]
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3)
      pass.end()
    }
    if (!encoder) {
      device.queue.submit([enc.finish()])
    }
  }
}
