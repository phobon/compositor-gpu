// The skeleton view (Compositor.skeleton): every instance quad outlined
// over the finished canvas, coloured by kind. Each record pass reports
// its quads from the CPU copy of its instance buffer
// (RenderPass.skeleton), so an outline is the quad the pass draws (shadow
// padding, glyph ink boxes, onGlyph offsets) rather than the record's
// rect. Material vertex hooks, layer transforms and clips are not
// applied. Opacity groups are outlined dashed at their bounds.

import type { Scene } from '../scene/scene'
import { reportShaderErrors } from '../util/log'
import { FRAME_WGSL, type RenderPass, type Shared } from './frame'
import { StorageArray } from './storage'
import { timed } from './timer'

/** What a skeleton quad outlines; indexes SKELETON_COLORS. */
export const SkeletonKind = {
  box: 0,
  shadow: 1,
  image: 2,
  glyph: 3,
  fallback: 4,
  cutout: 5,
  group: 6
} as const
export type SkeletonKind = (typeof SkeletonKind)[keyof typeof SkeletonKind]

/** Outline colour per kind (sRGB hex), in SkeletonKind order. */
export const SKELETON_COLORS: readonly string[] = [
  '#22d3ee',
  '#a78bfa',
  '#f59e0b',
  '#34d399',
  '#f472b6',
  '#ef4444',
  '#e5e7eb'
]

// xf0 (a, b, c, d), xf1 (tx, ty, space, kind), rect (x, y, w, h).
const FLOATS = 12

/** Collects quads for one frame. */
export class SkeletonSink {
  f32 = new Float32Array(FLOATS * 1024)
  count = 0

  /** The local rect (x, y, w, h) through the affine at m[at..at + 5]
   * (a, b, c, d, tx, ty), translated by (ox, oy). Empty rects are
   * dropped (zero instances). */
  quad(
    m: Float32Array,
    at: number,
    x: number,
    y: number,
    w: number,
    h: number,
    space: number,
    kind: SkeletonKind,
    ox = 0,
    oy = 0
  ): void {
    this.push(
      m[at] ?? 1,
      m[at + 1] ?? 0,
      m[at + 2] ?? 0,
      m[at + 3] ?? 1,
      (m[at + 4] ?? 0) + ox,
      (m[at + 5] ?? 0) + oy,
      x,
      y,
      w,
      h,
      space,
      kind
    )
  }

  push(
    a: number,
    b: number,
    c: number,
    d: number,
    tx: number,
    ty: number,
    x: number,
    y: number,
    w: number,
    h: number,
    space: number,
    kind: SkeletonKind
  ): void {
    if (!(w > 0 && h > 0)) {
      return
    }
    let f = this.f32
    const o = this.count * FLOATS
    if (o + FLOATS > f.length) {
      const g = new Float32Array(f.length * 2)
      g.set(f)
      this.f32 = g
      f = g
    }
    f[o] = a
    f[o + 1] = b
    f[o + 2] = c
    f[o + 3] = d
    f[o + 4] = tx
    f[o + 5] = ty
    f[o + 6] = space
    f[o + 7] = kind
    f[o + 8] = x
    f[o + 9] = y
    f[o + 10] = w
    f[o + 11] = h
    this.count++
  }
}

function colorWgsl(): string {
  const cases = SKELETON_COLORS.map((hex, i) => {
    const n = Number.parseInt(hex.slice(1), 16)
    const r = ((n >> 16) & 255) / 255
    const g = ((n >> 8) & 255) / 255
    const b = (n & 255) / 255
    return `    case ${i}u: { return vec3f(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)}); }`
  })
  return `fn kind_color(k : u32) -> vec3f {
  switch k {
${cases.join('\n')}
    default: { return vec3f(1.0); }
  }
}`
}

const SHADER = /* wgsl */ `
${FRAME_WGSL}

struct Quad {
  xf0  : vec4f,   // a, b, c, d: linear part of local -> record space
  xf1  : vec4f,   // tx, ty, space (1 = viewport), kind
  rect : vec4f,   // x, y, w, h (local)
};
@group(1) @binding(0) var<storage, read> quads : array<Quad>;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) lp : vec2f,
  @location(1) @interpolate(flat) ii : u32,
  @location(2) @interpolate(flat) sc : vec2f,
};

${colorWgsl()}

@vertex
fn vs(@builtin(vertex_index) vi : u32,
      @builtin(instance_index) ii : u32) -> VOut {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let q = quads[ii];
  let m = q.xf0;
  // Device px per local unit along each axis; the quad grows by 1.5
  // device px per side so the line straddles the edge.
  let sc = vec2f(length(m.xy), length(m.zw)) * frame.dpr;
  let pad = 1.5 / max(sc, vec2f(1e-3));
  let lp = q.rect.xy - pad + corners[vi] * (q.rect.zw + 2.0 * pad);
  let p = vec2f(m.x * lp.x + m.z * lp.y, m.y * lp.x + m.w * lp.y) + q.xf1.xy;
  var out : VOut;
  out.pos = to_clip(p, q.xf1.z);
  out.lp = lp - q.rect.xy;
  out.ii = ii;
  out.sc = sc;
  return out;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  let q = quads[in.ii];
  let wh = q.rect.zw;
  // Device px to the nearest vertical / horizontal edge.
  let dx = min(abs(in.lp.x), abs(in.lp.x - wh.x)) * in.sc.x;
  let dy = min(abs(in.lp.y), abs(in.lp.y - wh.y)) * in.sc.y;
  var a = clamp(1.0 - min(dx, dy), 0.0, 1.0) * 0.9;
  let kind = u32(q.xf1.w + 0.5);
  if (kind == 6u) {
    // Groups dashed, 4 device px on, 4 off, along the nearest edge.
    let along = select(in.lp.x * in.sc.x, in.lp.y * in.sc.y, dx < dy);
    if (fract(along / 8.0) > 0.5) { a = 0.0; }
  }
  if (a <= 0.0) { discard; }
  return vec4f(kind_color(kind) * a, a);
}
`

/** Draws the skeleton over a finished target (Renderer, when on). */
export class SkeletonPass {
  private readonly sink = new SkeletonSink()
  private readonly quads: StorageArray
  private readonly layout: GPUBindGroupLayout
  private readonly pipeline: GPURenderPipeline
  private bindGroup: GPUBindGroup | null = null
  /** Quads drawn last frame (stats). */
  count = 0

  constructor(private readonly shared: Shared) {
    const { device, format, frameLayout } = shared
    this.quads = new StorageArray(device, FLOATS, 1024, 'skeleton')
    this.layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' }
        }
      ]
    })
    const module = device.createShaderModule({ code: SHADER })
    reportShaderErrors(module, 'skeleton')
    const over: GPUBlendComponent = {
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha'
    }
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [frameLayout, this.layout]
      }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{ format, blend: { color: over, alpha: over } }]
      },
      primitive: { topology: 'triangle-list' }
    })
  }

  /** Outline the passes' last uploaded instances and the scene's groups
   * onto `view`, in its own pass, with the main Frame uniform. */
  draw(
    encoder: GPUCommandEncoder,
    view: GPUTextureView,
    passes: readonly RenderPass[],
    scene: Scene
  ): void {
    const s = this.sink
    s.count = 0
    for (const p of passes) {
      p.skeleton?.(s)
    }
    for (const g of scene.groups) {
      const b = g.bounds
      const doc = g.space !== 'viewport'
      s.push(1, 0, 0, 1, 0, 0, b.x, b.y, b.width, b.height, doc ? 0 : 1, 6)
      const v = g.vbounds
      if (v && doc) {
        s.push(1, 0, 0, 1, 0, 0, v.x, v.y, v.width, v.height, 1, 6)
      }
    }
    this.count = s.count
    if (s.count === 0) {
      return
    }
    if (this.quads.ensure(s.count) || !this.bindGroup) {
      this.bindGroup = this.shared.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.quads.buffer as GPUBuffer } }
        ]
      })
    }
    this.quads.f32.set(s.f32.subarray(0, s.count * FLOATS))
    this.quads.write(0, s.count)
    const rp = encoder.beginRenderPass({
      ...timed(this.shared.timer, 'skeleton'),
      colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }]
    })
    rp.setPipeline(this.pipeline)
    rp.setBindGroup(0, this.shared.frameBindGroup)
    rp.setBindGroup(1, this.bindGroup)
    rp.draw(6, s.count)
    rp.end()
  }

  destroy(): void {
    this.quads.destroy()
  }
}
