import { FRAME_WGSL, type RenderPass, type Shared } from '../gpu/frame'
import type { Scene } from '../scene/scene'
import { reportShaderErrors } from '../util/log'

const FLOATS_PER_BOX = 24 // 6 * vec4f
const BYTES_PER_BOX = FLOATS_PER_BOX * 4

const SHADER = /* wgsl */ `
${FRAME_WGSL}

struct Box {
  rect   : vec4f,   // x, y, w, h  (document space, CSS px)
  radius : vec4f,   // tl, tr, br, bl
  fill   : vec4f,   // linear rgba
  border : vec4f,   // linear rgba
  params : vec4f,   // borderWidth, opacity, z, _
  clip   : vec4f,   // minX, minY, maxX, maxY (doc space)
};
@group(1) @binding(0) var<storage, read> boxes : array<Box>;

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
  let b = boxes[ii];
  let corner = uv[vi];
  let p = b.rect.xy + corner * b.rect.zw;
  var out : VOut;
  out.pos = doc_to_clip(p);
  out.half = b.rect.zw * 0.5;
  out.local = (corner - vec2f(0.5)) * b.rect.zw;
  out.idx = ii;
  out.docp = p;
  return out;
}

// Signed distance to a rounded box with per-corner radius.
fn sd_round_box(p : vec2f, b : vec2f, r4 : vec4f) -> f32 {
  let top = select(r4.x, r4.y, p.x > 0.0);      // tl / tr
  let bot = select(r4.w, r4.z, p.x > 0.0);      // bl / br
  let r = select(top, bot, p.y > 0.0);
  let q = abs(p) - b + vec2f(r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - r;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  let b = boxes[in.idx];
  let cl = b.clip;
  if (in.docp.x < cl.x || in.docp.y < cl.y ||
      in.docp.x > cl.z || in.docp.y > cl.w) { discard; }
  let d = sd_round_box(in.local, in.half, b.radius);
  let aa = max(fwidth(d), 1e-4);
  let bw = b.params.x;
  let opacity = b.params.y;

  let outerCov = 1.0 - smoothstep(-aa, aa, d);
  let fillCov  = 1.0 - smoothstep(-aa, aa, d + bw);
  let borderCov = clamp(outerCov - fillCov, 0.0, 1.0);

  let rgb = (b.fill.rgb * b.fill.a * fillCov +
             b.border.rgb * b.border.a * borderCov) * opacity;
  let a = (b.fill.a * fillCov + b.border.a * borderCov) * opacity;
  return vec4f(rgb, a); // premultiplied
}
`

/**
 * Instanced rounded-rect pass: one storage-buffer entry per box, one draw call.
 * The simplest full vertical slice of the DOM -> GPU sync loop.
 */
export class BoxPass implements RenderPass {
  readonly layer = 'boxes' as const
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
    reportShaderErrors(module, 'box')
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [frameLayout, this.group1Layout]
      }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
            }
          }
        ]
      },
      primitive: { topology: 'triangle-list' }
    })
  }

  private ensureCapacity(n: number): void {
    if (n <= this.capacity) return
    const cap = Math.max(n, this.capacity ? this.capacity * 2 : 64)
    this.buffer?.destroy()
    this.buffer = this.shared.device.createBuffer({
      size: cap * BYTES_PER_BOX,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.bindGroup = this.shared.device.createBindGroup({
      layout: this.group1Layout,
      entries: [{ binding: 0, resource: { buffer: this.buffer } }]
    })
    this.data = new Float32Array(cap * FLOATS_PER_BOX)
    this.capacity = cap
  }

  upload(scene: Scene): void {
    const boxes = scene.boxes
    this.count = boxes.length
    if (this.count === 0) return
    this.ensureCapacity(this.count)
    const d = this.data
    let o = 0
    for (const b of boxes) {
      d[o++] = b.rect.x
      d[o++] = b.rect.y
      d[o++] = b.rect.width
      d[o++] = b.rect.height
      d[o++] = b.radius[0]
      d[o++] = b.radius[1]
      d[o++] = b.radius[2]
      d[o++] = b.radius[3]
      d[o++] = b.fill.r
      d[o++] = b.fill.g
      d[o++] = b.fill.b
      d[o++] = b.fill.a
      d[o++] = b.border?.color.r ?? 0
      d[o++] = b.border?.color.g ?? 0
      d[o++] = b.border?.color.b ?? 0
      d[o++] = b.border?.color.a ?? 0
      d[o++] = b.border?.width ?? 0
      d[o++] = b.opacity
      d[o++] = b.z
      d[o++] = 0
      const c = b.clip
      d[o++] = c ? c.x : -1e9
      d[o++] = c ? c.y : -1e9
      d[o++] = c ? c.x + c.width : 1e9
      d[o++] = c ? c.y + c.height : 1e9
    }
    this.shared.device.queue.writeBuffer(
      this.buffer as GPUBuffer,
      0,
      d,
      0,
      this.count * FLOATS_PER_BOX
    )
  }

  draw(encoder: GPURenderPassEncoder, first: number, count: number): void {
    if (count === 0 || !this.bindGroup) return
    encoder.setPipeline(this.pipeline)
    encoder.setBindGroup(1, this.bindGroup)
    encoder.draw(6, count, 0, first)
  }

  destroy(): void {
    this.buffer?.destroy()
  }
}
