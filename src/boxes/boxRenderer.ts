import { FRAME_WGSL, type RenderPass, type Shared } from '../gpu/frame'
import type { Scene } from '../scene/scene'
import { reportShaderErrors } from '../util/log'

const FLOATS_PER_BOX = 36 // 9 * vec4f
const BYTES_PER_BOX = FLOATS_PER_BOX * 4
const FLOATS_PER_STOP = 8 // [r,g,b,a] + [pos,0,0,0]
const BYTES_PER_STOP = FLOATS_PER_STOP * 4

const SHADER = /* wgsl */ `
${FRAME_WGSL}

struct Box {
  xf0    : vec4f,   // a, b, c, d: linear part of local -> doc
  xf1    : vec4f,   // tx, ty (doc space), w, h (local size, CSS px)
  radius : vec4f,   // tl, tr, br, bl
  fill   : vec4f,   // sRGB rgba
  border : vec4f,   // sRGB rgba
  params : vec4f,   // borderWidth, opacity, z, _
  clip   : vec4f,   // minX, minY, maxX, maxY (doc space)
  grad   : vec4f,   // kind (0 none, 1 linear, 2 radial), angle, start, count
  gradc  : vec4f,   // radial: cx, cy (padding-box fractions), rx, ry (px)
};
@group(1) @binding(0) var<storage, read> boxes : array<Box>;
// Two entries per stop: sRGB straight-alpha rgba, then (pos, 0, 0, 0).
@group(1) @binding(1) var<storage, read> stops : array<vec4f>;

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
  let size = b.xf1.zw;
  let lp = corner * size;
  let m = b.xf0;
  let p = vec2f(m.x * lp.x + m.z * lp.y, m.y * lp.x + m.w * lp.y) + b.xf1.xy;
  var out : VOut;
  out.pos = doc_to_clip(p);
  out.half = size * 0.5;
  // Centred local coords: the SDF and gradients run in the untransformed
  // box, and fwidth() picks up the transform's scale/rotation for AA.
  out.local = lp - size * 0.5;
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

// Interpolate two sRGB straight-alpha stops in premultiplied sRGB (the CSS
// default), returning sRGB straight alpha.
fn mix_stops(c0 : vec4f, c1 : vec4f, f : f32) -> vec4f {
  let p0 = c0.rgb * c0.a;
  let p1 = c1.rgb * c1.a;
  let a = mix(c0.a, c1.a, f);
  let s = mix(p0, p1, f) / max(a, 1e-6);
  return vec4f(s, a);
}

// Colour at gradient-line position t. Stops are sorted by position (CSS
// fix-up); t outside [first, last] takes the end colour.
fn gradient_at(t : f32, start : u32, count : u32) -> vec4f {
  if (count == 0u) { return vec4f(0.0); }
  var c0 = stops[start * 2u];
  var p0 = stops[start * 2u + 1u].x;
  if (t <= p0) { return c0; }
  for (var i = 1u; i < count; i = i + 1u) {
    let c1 = stops[(start + i) * 2u];
    let p1 = stops[(start + i) * 2u + 1u].x;
    if (t <= p1) {
      let f = select(0.0, (t - p0) / (p1 - p0), p1 > p0);
      return mix_stops(c0, c1, f);
    }
    c0 = c1;
    p0 = p1;
  }
  return c0;
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

  // Background: gradient over fill, source-over, kept premultiplied.
  var bgp = b.fill.rgb * b.fill.a;
  var bga = b.fill.a;
  if (b.grad.x > 0.5) {
    // Gradient box = padding box, centred like the border box.
    let size = max(b.xf1.zw - vec2f(2.0 * bw), vec2f(0.0));
    var t = 0.0;
    if (b.grad.x < 1.5) {
      let ang = b.grad.y;
      let dir = vec2f(sin(ang), -cos(ang));
      let len = abs(size.x * sin(ang)) + abs(size.y * cos(ang));
      t = dot(in.local, dir) / max(len, 1e-4) + 0.5;
    } else {
      let c = (b.gradc.xy - vec2f(0.5)) * size;
      t = length((in.local - c) / max(b.gradc.zw, vec2f(1e-4)));
    }
    let g = gradient_at(t, u32(b.grad.z), u32(b.grad.w));
    bgp = g.rgb * g.a + bgp * (1.0 - g.a);
    bga = g.a + bga * (1.0 - g.a);
  }

  let rgb = (bgp * fillCov +
             b.border.rgb * b.border.a * borderCov) * opacity;
  let a = (bga * fillCov + b.border.a * borderCov) * opacity;
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
  private stopBuffer: GPUBuffer | null = null
  private stopCapacity = 0
  private stopData = new Float32Array(0)

  constructor(private readonly shared: Shared) {
    const { device, format, frameLayout } = shared
    this.group1Layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
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

  /** Grow the instance buffer; returns true when it was recreated. */
  private ensureCapacity(n: number): boolean {
    if (n <= this.capacity) return false
    const cap = Math.max(n, this.capacity ? this.capacity * 2 : 64)
    this.buffer?.destroy()
    this.buffer = this.shared.device.createBuffer({
      size: cap * BYTES_PER_BOX,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.data = new Float32Array(cap * FLOATS_PER_BOX)
    this.capacity = cap
    return true
  }

  /**
   * Grow the stop buffer; returns true when it was recreated. Always holds
   * at least one stop so the bind group is valid with no gradients.
   */
  private ensureStopCapacity(n: number): boolean {
    const need = Math.max(n, 1)
    if (need <= this.stopCapacity) return false
    const cap = Math.max(need, this.stopCapacity ? this.stopCapacity * 2 : 16)
    this.stopBuffer?.destroy()
    this.stopBuffer = this.shared.device.createBuffer({
      size: cap * BYTES_PER_STOP,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.stopData = new Float32Array(cap * FLOATS_PER_STOP)
    this.stopCapacity = cap
    return true
  }

  upload(scene: Scene): void {
    const boxes = scene.boxes
    this.count = boxes.length
    if (this.count === 0) return
    let stopCount = 0
    for (const b of boxes) stopCount += b.gradient?.stops.length ?? 0
    const grewBoxes = this.ensureCapacity(this.count)
    const grewStops = this.ensureStopCapacity(stopCount)
    if (grewBoxes || grewStops || !this.bindGroup) {
      this.bindGroup = this.shared.device.createBindGroup({
        layout: this.group1Layout,
        entries: [
          { binding: 0, resource: { buffer: this.buffer as GPUBuffer } },
          { binding: 1, resource: { buffer: this.stopBuffer as GPUBuffer } }
        ]
      })
    }
    const d = this.data
    const sd = this.stopData
    let o = 0
    let so = 0
    for (const b of boxes) {
      const xf = b.xform
      d[o++] = xf[0]
      d[o++] = xf[1]
      d[o++] = xf[2]
      d[o++] = xf[3]
      d[o++] = xf[4]
      d[o++] = xf[5]
      d[o++] = b.local.w
      d[o++] = b.local.h
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
      const g = b.gradient
      if (g && g.stops.length >= 2) {
        d[o++] = g.kind === 'linear' ? 1 : 2
        d[o++] = g.angle
        d[o++] = so / FLOATS_PER_STOP
        d[o++] = g.stops.length
        d[o++] = g.center[0]
        d[o++] = g.center[1]
        d[o++] = g.radii[0]
        d[o++] = g.radii[1]
        for (const st of g.stops) {
          sd[so++] = st.color.r
          sd[so++] = st.color.g
          sd[so++] = st.color.b
          sd[so++] = st.color.a
          sd[so++] = st.pos
          sd[so++] = 0
          sd[so++] = 0
          sd[so++] = 0
        }
      } else {
        for (let k = 0; k < 8; k++) d[o++] = 0
      }
    }
    this.shared.device.queue.writeBuffer(
      this.buffer as GPUBuffer,
      0,
      d,
      0,
      this.count * FLOATS_PER_BOX
    )
    if (so > 0) {
      this.shared.device.queue.writeBuffer(
        this.stopBuffer as GPUBuffer,
        0,
        sd,
        0,
        so
      )
    }
  }

  draw(encoder: GPURenderPassEncoder, first: number, count: number): void {
    if (count === 0 || !this.bindGroup) return
    encoder.setPipeline(this.pipeline)
    encoder.setBindGroup(1, this.bindGroup)
    encoder.draw(6, count, 0, first)
  }

  destroy(): void {
    this.buffer?.destroy()
    this.stopBuffer?.destroy()
  }
}
