import { MAX_FILTER_OPS } from '../scene/filter'
import type { BackdropRecord } from '../scene/records'
import { reportShaderErrors } from '../util/log'
import type { GroupTarget } from './composite'
import { FRAME_WGSL, type Shared } from './frame'

// CSS `backdrop-filter`: draws a filtered copy of a target's backdrop
// (rendered by the Renderer into a pooled texture aligned to the target's
// pixels) inside an element's rounded border box. The colour functions
// apply here, after the blur; the shape is the element's own (through its
// transform), times its ancestors' clip shape.

/** Floats per instance: 8 vec4. */
const FLOATS = 32
const FLOATS_PER_MATRIX = 20

const WGSL = /* wgsl */ `
${FRAME_WGSL}

struct Back {
  c01  : vec4f,   // record-space corners of the (padded) border box: tl, tr
  c23  : vec4f,   // bl, br
  inv0 : vec4f,   // record space -> local, linear part
  inv1 : vec4f,   // translation; border box w, h
  rx   : vec4f,   // radii tl, tr, br, bl (horizontal)
  ry   : vec4f,   // vertical
  misc : vec4f,   // space; ancestor clip shape; texture origin in the
                  // target (device px)
  ops  : vec4f,   // colour functions: count, first matrix
};
@group(1) @binding(0) var<storage, read> backs : array<Back>;
@group(1) @binding(1) var src : texture_2d<f32>;
@group(1) @binding(2) var<storage, read> mats : array<vec4f>;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) recp : vec2f,
  @location(1) @interpolate(flat) inst : u32,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32,
      @builtin(instance_index) ii : u32) -> VOut {
  var at = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u);
  let b = backs[ii];
  let q = array<vec2f, 4>(b.c01.xy, b.c01.zw, b.c23.xy, b.c23.zw);
  let p = q[at[vi]];
  var out : VOut;
  out.pos = to_clip(p, b.misc.x);
  out.recp = p;
  out.inst = ii;
  return out;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  let b = backs[in.inst];
  let size = vec2i(textureDimensions(src)) - vec2i(1);
  let texel = clamp(vec2i(in.pos.xy - b.misc.zw), vec2i(0), size);
  var t = textureLoad(src, texel, 0);
  let n = u32(b.ops.x);
  if (n > 0u) {
    var u = select(vec4f(0.0), vec4f(t.rgb / t.a, t.a), t.a > 0.0);
    let first = u32(b.ops.y);
    for (var i = 0u; i < n; i++) {
      let o = (first + i) * 5u;
      u = clamp(
        vec4f(
          dot(mats[o], u),
          dot(mats[o + 1u], u),
          dot(mats[o + 2u], u),
          dot(mats[o + 3u], u)
        ) + mats[o + 4u],
        vec4f(0.0),
        vec4f(1.0)
      );
    }
    t = vec4f(u.rgb * u.a, u.a);
  }
  let p = in.recp;
  let l = vec2f(b.inv0.x * p.x + b.inv0.z * p.y + b.inv1.x,
                b.inv0.y * p.x + b.inv0.w * p.y + b.inv1.y);
  let half = b.inv1.zw * 0.5;
  let d = frame_clip_sd(l - half, half, b.rx, b.ry);
  let px = length(b.inv0) * 0.70710678 / max(frame.dpr, 1e-3);
  let cov = clamp(0.5 - d / max(px, 1e-4), 0.0, 1.0) *
    frame_clip_cov(p, b.misc.y);
  return t * cov;
}
`

type Affine = readonly [number, number, number, number, number, number]

function invert(m: Affine): Affine | null {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  if (Math.abs(det) < 1e-12) {
    return null
  }
  const ia = d / det
  const ib = -b / det
  const ic = -c / det
  const id = a / det
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)]
}

export class BackdropPass {
  private readonly pipeline: GPURenderPipeline
  private readonly layout: GPUBindGroupLayout
  private buffer: GPUBuffer | null = null
  private matBuffer: GPUBuffer | null = null
  private capacity = 0
  private matCapacity = 0
  private data: number[] = []
  private mats: number[] = []
  constructor(private readonly shared: Shared) {
    const { device, format } = shared
    this.layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' }
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' }
        }
      ]
    })
    const module = device.createShaderModule({ label: 'backdrop', code: WGSL })
    reportShaderErrors(module, 'backdrop')
    this.pipeline = device.createRenderPipeline({
      label: 'backdrop',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [shared.frameLayout, this.layout]
      }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format,
            blend: {
              color: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add'
              },
              alpha: {
                srcFactor: 'one',
                dstFactor: 'one-minus-src-alpha',
                operation: 'add'
              }
            }
          }
        ]
      },
      primitive: { topology: 'triangle-list' }
    })
  }

  /** Start a frame that draws up to `count` backdrops with `matrices`
   * colour functions in all: the buffers are sized once, up front, since
   * every draw of the frame binds them. */
  begin(count: number, matrices: number): void {
    this.data = []
    this.mats = []
    this.ensure(count, matrices * FLOATS_PER_MATRIX)
  }

  /**
   * Record `rec`'s filtered backdrop: `tex` holds the target's pixels
   * from (`ox`, `oy`) device px on, already blurred. `clip` is the clip
   * shape index of its ancestors (0 none). Instance data is uploaded by
   * flush(), before submit.
   */
  draw(
    rp: GPURenderPassEncoder,
    tex: GroupTarget,
    rec: BackdropRecord,
    ox: number,
    oy: number,
    clip: number
  ): void {
    const inv = invert(rec.xform)
    if (!inv) {
      return
    }
    const { w, h } = rec.local
    const [a, b, c, d, e, f] = rec.xform
    const at = (x: number, y: number): [number, number] => [
      a * x + c * y + e,
      b * x + d * y + f
    ]
    // A device pixel of room for the edge's anti-aliasing.
    const pad = 1
    const r = rec.radius
    const ry = rec.radiusY ?? r
    const index = this.data.length / FLOATS
    this.data.push(
      ...at(-pad, -pad),
      ...at(w + pad, -pad),
      ...at(-pad, h + pad),
      ...at(w + pad, h + pad),
      ...inv.slice(0, 4),
      inv[4],
      inv[5],
      w,
      h,
      ...r,
      ...ry,
      rec.space === 'viewport' ? 1 : 0,
      clip,
      ox,
      oy
    )
    const first = this.mats.length / FLOATS_PER_MATRIX
    const n = Math.min(rec.filter.matrices.length, MAX_FILTER_OPS)
    for (let i = 0; i < n; i++) {
      const m = rec.filter.matrices[i] ?? []
      for (let row = 0; row < 4; row++) {
        for (let k = 0; k < 4; k++) {
          this.mats.push(m[row * 5 + k] ?? 0)
        }
      }
      for (let row = 0; row < 4; row++) {
        this.mats.push(m[row * 5 + 4] ?? 0)
      }
    }
    this.data.push(n, first, 0, 0)
    const buffer = this.buffer
    const matBuffer = this.matBuffer
    if (!buffer || !matBuffer || index >= this.capacity) {
      return
    }
    const bindGroup = this.shared.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer } },
        { binding: 1, resource: tex.view },
        { binding: 2, resource: { buffer: matBuffer } }
      ]
    })
    rp.setPipeline(this.pipeline)
    rp.setBindGroup(1, bindGroup)
    rp.draw(6, 1, 0, index)
  }

  private ensure(n: number, matFloats: number): void {
    const { device } = this.shared
    if (n > this.capacity || !this.buffer) {
      this.buffer?.destroy()
      this.capacity = Math.max(16, this.capacity * 2, n)
      this.buffer = device.createBuffer({
        label: 'backdrop',
        size: this.capacity * FLOATS * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      })
    }
    const mf = Math.max(matFloats, FLOATS_PER_MATRIX)
    if (mf > this.matCapacity || !this.matBuffer) {
      this.matBuffer?.destroy()
      this.matCapacity = Math.max(
        16 * FLOATS_PER_MATRIX,
        this.matCapacity * 2,
        mf
      )
      this.matBuffer = device.createBuffer({
        label: 'backdrop-mats',
        size: this.matCapacity * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      })
    }
  }

  /** Upload this frame's instances. Call before submit. */
  flush(): void {
    const { device } = this.shared
    if (this.data.length > 0 && this.buffer) {
      device.queue.writeBuffer(this.buffer, 0, new Float32Array(this.data))
    }
    if (this.mats.length > 0 && this.matBuffer) {
      device.queue.writeBuffer(this.matBuffer, 0, new Float32Array(this.mats))
    }
  }

  destroy(): void {
    this.buffer?.destroy()
    this.matBuffer?.destroy()
  }
}
