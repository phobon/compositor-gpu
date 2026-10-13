import { reportShaderErrors } from '../util/log'
import type { GroupTarget } from './composite'
import type { Shared } from './frame'
import { timed } from './timer'

// CSS `filter: blur()` on an opacity group: a separable Gaussian over the
// group's texture (horizontal, then vertical), each pass from one pooled
// target into another. Both use the top-left w×h device px, where the
// group was drawn; the rest of a pooled texture is cleared, so samples
// past the edge read transparent. Above 48 taps a side the taps spread
// out (step > 1) to bound the cost.
//
// CSS `filter: drop-shadow()` runs the same two passes over the group's
// texture: the first samples it shifted by the shadow's offset, the
// second tints the blurred alpha and draws the original over it.

const BLUR_WGSL = /* wgsl */ `
struct Blur {
  dir    : vec2f,   // (1, 0) or (0, 1)
  texel  : vec2f,   // 1 / source texture size
  sigma  : f32,     // device px
  radius : f32,     // taps reach ±radius device px
  step   : f32,     // device px between taps
  shadow : f32,     // 1: tint the result alpha, orig over it
  offset : vec2f,   // device px the source is shifted by
  _pad   : vec2f,
  tint   : vec4f,   // premultiplied shadow colour
};
@group(0) @binding(0) var<uniform> blur : Blur;
@group(0) @binding(1) var src : texture_2d<f32>;
@group(0) @binding(2) var samp : sampler;
@group(0) @binding(3) var orig : texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let p = pos.xy - blur.offset;
  var acc = vec4f(0.0);
  if (blur.sigma < 0.01) {
    acc = textureSampleLevel(src, samp, p * blur.texel, 0.0);
  } else {
    let k = -0.5 / (blur.sigma * blur.sigma);
    var total = 0.0;
    var o = -blur.radius;
    loop {
      if (o > blur.radius) {
        break;
      }
      let w = exp(o * o * k);
      let uv = (p + blur.dir * o) * blur.texel;
      acc += textureSampleLevel(src, samp, uv, 0.0) * w;
      total += w;
      o += blur.step;
    }
    acc = acc / total;
  }
  if (blur.shadow > 0.5) {
    let c = textureSampleLevel(orig, samp,
      pos.xy / vec2f(textureDimensions(orig)), 0.0);
    return c + blur.tint * acc.a * (1.0 - c.a);
  }
  return acc;
}
`

const UNIFORM_BYTES = 64

export class GroupBlur {
  private readonly pipeline: GPURenderPipeline
  private readonly layout: GPUBindGroupLayout
  private readonly sampler: GPUSampler
  /** Uniform buffers, one per pass recorded this frame (each is written
   * before submit, so passes can't share one). */
  private readonly uniforms: GPUBuffer[] = []
  private used = 0

  constructor(private readonly shared: Shared) {
    const { device, format } = shared
    this.layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' }
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' }
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' }
        }
      ]
    })
    const module = device.createShaderModule({
      label: 'group-blur',
      code: BLUR_WGSL
    })
    reportShaderErrors(module, 'group-blur')
    this.pipeline = device.createRenderPipeline({
      label: 'group-blur',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' }
    })
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge'
    })
  }

  /** Start a frame: uniform buffers are reused from the first again. */
  begin(): void {
    this.used = 0
  }

  /** Blur the top-left w×h of `from` along `dir` into `to`. `offset`
   * (device px) shifts the source; with `shadow` the result's alpha is
   * tinted (premultiplied) and `orig` drawn over it. */
  run(
    encoder: GPUCommandEncoder,
    from: Pick<GroupTarget, 'view' | 'width' | 'height'>,
    to: GroupTarget,
    w: number,
    h: number,
    dir: [number, number],
    sigma: number,
    opts: {
      offset?: [number, number]
      shadow?: { tint: [number, number, number, number]; orig: GroupTarget }
    } = {}
  ): void {
    const { device } = this.shared
    let buffer = this.uniforms[this.used]
    if (!buffer) {
      buffer = device.createBuffer({
        label: 'group-blur',
        size: UNIFORM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      })
      this.uniforms.push(buffer)
    }
    this.used++
    const radius = sigma < 0.01 ? 0 : Math.ceil(sigma * 3)
    const offset = opts.offset ?? [0, 0]
    const tint = opts.shadow?.tint ?? [0, 0, 0, 0]
    const step = Math.max(1, Math.ceil(radius / 48))
    device.queue.writeBuffer(
      buffer,
      0,
      new Float32Array([
        dir[0],
        dir[1],
        1 / from.width,
        1 / from.height,
        sigma,
        radius,
        step,
        opts.shadow ? 1 : 0,
        offset[0],
        offset[1],
        0,
        0,
        ...tint
      ])
    )
    const bindGroup = device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: from.view },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: (opts.shadow?.orig ?? from).view }
      ]
    })
    const rp = encoder.beginRenderPass({
      ...timed(this.shared.timer, 'filter'),
      colorAttachments: [
        {
          view: to.view,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    })
    rp.setPipeline(this.pipeline)
    rp.setBindGroup(0, bindGroup)
    rp.setScissorRect(0, 0, Math.min(w, to.width), Math.min(h, to.height))
    rp.draw(3)
    rp.end()
  }

  destroy(): void {
    for (const b of this.uniforms) {
      b.destroy()
    }
    this.uniforms.length = 0
  }
}
