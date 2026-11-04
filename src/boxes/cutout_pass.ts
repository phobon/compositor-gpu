import { type RenderPass, resolveShader, type Shared } from '../gpu/frame'
import {
  quadVerts,
  SKELETON_WGSL,
  SkeletonTwin,
  skeletonFs
} from '../gpu/skeleton'
import { StorageArray } from '../gpu/storage'
import type { Scene } from '../scene/scene'
import { reportShaderErrors } from '../util/log'
import { CUT_AT, CUT_EXTERNALS, FLOATS_PER_CUT } from './box_data'

const SHADER = resolveShader(
  /* wgsl */ `
${SKELETON_WGSL}
${skeletonFs('cutout')}

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
  let lp = uv[skeleton_vi(vi)] * size;
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

// sd_box and edge_cov, as in the box pass, so a hole lines up with a box
// of the same geometry.

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
  let d = sd_box(in.local, in.half, c.radius, c.ry);
  return vec4f(0.0, 0.0, 0.0,
    edge_cov(d, apx) * frame_clip_cov(in.docp, c.params.y));
}
`,
  CUT_EXTERNALS
)

/**
 * Erases the mirror under `data-gpu-ignore` elements (CutoutRecords), at
 * their paint-order position: one rounded-rect quad per record, blended
 * destination-out, so the element's own DOM paint shows through the
 * canvas. Inside an opacity group it clears the group's target only.
 */
export class CutoutPass implements RenderPass {
  readonly layer = 'cutouts' as const
  private pipeline: SkeletonTwin
  private group1Layout: GPUBindGroupLayout
  private readonly cuts: StorageArray
  private bindGroup: GPUBindGroup | null = null
  private count = 0

  constructor(private readonly shared: Shared) {
    const { device, format, frameLayout } = shared
    this.cuts = new StorageArray(device, FLOATS_PER_CUT, 16)
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
    this.pipeline = new SkeletonTwin(device, {
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

  upload(scene: Scene): void {
    const cuts = scene.cutouts
    this.count = cuts.length
    if (this.count === 0) {
      return
    }
    if (this.cuts.ensure(this.count) || !this.bindGroup) {
      this.bindGroup = this.shared.device.createBindGroup({
        layout: this.group1Layout,
        entries: [
          { binding: 0, resource: { buffer: this.cuts.buffer as GPUBuffer } }
        ]
      })
    }
    const d = this.cuts.f32
    const dpr = this.shared.dpr > 0 ? this.shared.dpr : 1
    const snap = (v: number) => Math.round(v * dpr) / dpr
    const put = (
      o: number,
      f: keyof typeof CUT_AT,
      x: number,
      y: number,
      z: number,
      w: number
    ): void => {
      const at = o + CUT_AT[f]
      d[at] = x
      d[at + 1] = y
      d[at + 2] = z
      d[at + 3] = w
    }
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
      put(o, 'xf0', xf[0], xf[1], xf[2], xf[3])
      put(o, 'xf1', tx, ty, w, h)
      const r = c.radius
      put(o, 'radius', r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 0)
      const cl = c.clip
      put(
        o,
        'clip',
        cl ? cl.x : -1e9,
        cl ? cl.y : -1e9,
        cl ? cl.x + cl.width : 1e9,
        cl ? cl.y + cl.height : 1e9
      )
      put(
        o,
        'params',
        c.space === 'viewport' ? 1 : 0,
        scene.clipIndex(c.clip),
        0,
        0
      )
      const ry = c.radiusY ?? c.radius
      put(o, 'ry', ry[0] ?? 0, ry[1] ?? 0, ry[2] ?? 0, ry[3] ?? 0)
      o += FLOATS_PER_CUT
    }
    this.cuts.write(0, this.count)
  }

  draw(encoder: GPURenderPassEncoder, first: number, count: number): number {
    if (count === 0 || !this.bindGroup) {
      return 0
    }
    const skeleton = this.shared.skeleton
    encoder.setPipeline(this.pipeline.get(skeleton))
    encoder.setBindGroup(1, this.bindGroup)
    encoder.draw(quadVerts(skeleton), count, 0, first)
    return 1
  }

  destroy(): void {
    this.cuts.destroy()
  }
}
