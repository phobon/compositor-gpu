import { FRAME_WGSL, type RenderPass, type Shared } from '../gpu/frame'
import type { Scene } from '../scene/scene'
import { reportShaderErrors } from '../util/log'

const FLOATS_PER_CUT = 20 // 5 * vec4f
const BYTES_PER_CUT = FLOATS_PER_CUT * 4

const SHADER = /* wgsl */ `
${FRAME_WGSL}

struct Cut {
  xf0    : vec4f,   // a, b, c, d: linear part of local -> doc
  xf1    : vec4f,   // tx, ty (record space), w, h (local size, CSS px)
  radius : vec4f,   // tl, tr, br, bl
  clip   : vec4f,   // minX, minY, maxX, maxY (the record's space)
  params : vec4f,   // space, 0, 0, 0
};
@group(1) @binding(0) var<storage, read> cuts : array<Cut>;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) local : vec2f,
  @location(1) half  : vec2f,
  @location(2) @interpolate(flat) idx : u32,
  @location(3) docp : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32,
      @builtin(instance_index) ii : u32) -> VOut {
  var uv = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let c = cuts[ii];
  let size = c.xf1.zw;
  let lp = uv[vi] * size;
  let m = c.xf0;
  let p = vec2f(m.x * lp.x + m.z * lp.y, m.y * lp.x + m.w * lp.y) + c.xf1.xy;
  var out : VOut;
  out.pos = to_clip(p, c.params.x);
  out.half = size * 0.5;
  out.local = lp - size * 0.5;
  out.idx = ii;
  out.docp = p;
  return out;
}

// Same SDF and edge ramp as the box pass, so a hole lines up with a box
// of the same geometry.
fn sd_round_box(p : vec2f, b : vec2f, r4 : vec4f) -> f32 {
  let top = select(r4.x, r4.y, p.x > 0.0);
  let bot = select(r4.w, r4.z, p.x > 0.0);
  let r = select(top, bot, p.y > 0.0);
  let q = abs(p) - b + vec2f(r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - r;
}

fn edge_cov(d : f32, fw : f32) -> f32 {
  return clamp(0.5 - d / fw, 0.0, 1.0);
}

// Output alpha = coverage; the pipeline blends it destination-out
// (dst * (1 - a)), erasing what was drawn before.
@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  let c = cuts[in.idx];
  let apx = max(length(vec2f(length(dpdx(in.local)),
                             length(dpdy(in.local)))) * 0.70710678, 1e-4);
  let cl = c.clip;
  if (in.docp.x < cl.x || in.docp.y < cl.y ||
      in.docp.x > cl.z || in.docp.y > cl.w) { discard; }
  let d = sd_round_box(in.local, in.half, c.radius);
  return vec4f(0.0, 0.0, 0.0, edge_cov(d, apx));
}
`

/**
 * Erases the mirror under `data-gpu-ignore` elements (CutoutRecords), at
 * their paint-order position: one rounded-rect quad per record, blended
 * destination-out, so the element's own DOM paint shows through the
 * canvas. Inside an opacity group it clears the group's target only.
 */
export class CutoutPass implements RenderPass {
  readonly layer = 'cutouts' as const
  private pipeline: GPURenderPipeline
  private group1Layout: GPUBindGroupLayout
  private buffer: GPUBuffer | null = null
  private bindGroup: GPUBindGroup | null = null
  private capacity = 0
  private count = 0
  private data = new Float32Array(0)

  constructor(private readonly shared: Shared) {
    const { device, format, frameLayout } = shared
    this.group1Layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' }
        }
      ]
    })
    const module = device.createShaderModule({ code: SHADER })
    reportShaderErrors(module, 'cutout')
    const erase: GPUBlendComponent = {
      srcFactor: 'zero',
      dstFactor: 'one-minus-src-alpha'
    }
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [frameLayout, this.group1Layout]
      }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{ format, blend: { color: erase, alpha: erase } }]
      },
      primitive: { topology: 'triangle-list' }
    })
  }

  private ensureCapacity(n: number): boolean {
    if (n <= this.capacity) {
      return false
    }
    const cap = Math.max(n, this.capacity ? this.capacity * 2 : 16)
    this.buffer?.destroy()
    this.buffer = this.shared.device.createBuffer({
      size: cap * BYTES_PER_CUT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.data = new Float32Array(cap * FLOATS_PER_CUT)
    this.capacity = cap
    return true
  }

  upload(scene: Scene): void {
    const cuts = scene.cutouts
    this.count = cuts.length
    if (this.count === 0) {
      return
    }
    if (this.ensureCapacity(this.count) || !this.bindGroup) {
      this.bindGroup = this.shared.device.createBindGroup({
        layout: this.group1Layout,
        entries: [
          { binding: 0, resource: { buffer: this.buffer as GPUBuffer } }
        ]
      })
    }
    const d = this.data
    const dpr = this.shared.dpr > 0 ? this.shared.dpr : 1
    const snap = (v: number) => Math.round(v * dpr) / dpr
    let o = 0
    for (const c of cuts) {
      const xf = c.xform
      // Snap untransformed edges to device px, as the box pass does.
      const flat = xf[0] === 1 && xf[1] === 0 && xf[2] === 0 && xf[3] === 1
      let tx = xf[4]
      let ty = xf[5]
      let w = c.local.w
      let h = c.local.h
      if (flat) {
        const x0 = snap(tx)
        const y0 = snap(ty)
        w = Math.max(snap(tx + w) - x0, 0)
        h = Math.max(snap(ty + h) - y0, 0)
        tx = x0
        ty = y0
      }
      d[o++] = xf[0]
      d[o++] = xf[1]
      d[o++] = xf[2]
      d[o++] = xf[3]
      d[o++] = tx
      d[o++] = ty
      d[o++] = w
      d[o++] = h
      for (let k = 0; k < 4; k++) {
        d[o++] = c.radius[k] ?? 0
      }
      const cl = c.clip
      d[o++] = cl ? cl.x : -1e9
      d[o++] = cl ? cl.y : -1e9
      d[o++] = cl ? cl.x + cl.width : 1e9
      d[o++] = cl ? cl.y + cl.height : 1e9
      d[o++] = c.space === 'viewport' ? 1 : 0
      d[o++] = 0
      d[o++] = 0
      d[o++] = 0
    }
    this.shared.device.queue.writeBuffer(
      this.buffer as GPUBuffer,
      0,
      d,
      0,
      this.count * FLOATS_PER_CUT
    )
  }

  draw(encoder: GPURenderPassEncoder, first: number, count: number): number {
    if (count === 0 || !this.bindGroup) {
      return 0
    }
    encoder.setPipeline(this.pipeline)
    encoder.setBindGroup(1, this.bindGroup)
    encoder.draw(6, count, 0, first)
    return 1
  }

  destroy(): void {
    this.buffer?.destroy()
  }
}
