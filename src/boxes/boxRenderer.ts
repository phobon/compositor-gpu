import { shadowPad } from '../dom/styles'
import { FRAME_WGSL, type RenderPass, type Shared } from '../gpu/frame'
import type { Scene } from '../scene/scene'
import { reportShaderErrors } from '../util/log'

const FLOATS_PER_BOX = 64 // 16 * vec4f
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
  bc0    : vec4f,   // top border colour, sRGB rgba
  params : vec4f,   // (unused), opacity, z, space (1 = viewport)
  clip   : vec4f,   // minX, minY, maxX, maxY (the record's space)
  grad   : vec4f,   // kind (0 none, 1 linear, 2 radial), angle, start, count
  gradc  : vec4f,   // radial: cx, cy (padding-box fractions), rx, ry (px)
  sh0    : vec4f,   // shadow: sigma, pad (local px), isShadow, inset
  sh1    : vec4f,   // shadow: inner box x, y, w, h (local px) — the
                    // element box (outer) or the shadow box (inset)
  shr    : vec4f,   // shadow: inner radii tl, tr, br, bl
  bw     : vec4f,   // border widths top, right, bottom, left
  bc1    : vec4f,   // right border colour
  bc2    : vec4f,   // bottom border colour
  bc3    : vec4f,   // left border colour
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
  out.pos = to_clip(p, b.params.w);
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

// erf approximation (Abramowitz & Stegun 7.1.27, max error 5e-4).
fn erf2(x : vec2f) -> vec2f {
  let s = sign(x);
  let a = abs(x);
  var t = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
  t = t * t;
  return s - s / (t * t);
}

fn gaussian(x : f32, sigma : f32) -> f32 {
  return exp(-(x * x) / (2.0 * sigma * sigma)) / (2.5066283 * sigma);
}

// Blurred coverage of one row (height offset y from the centre) of a
// rounded box, integrated exactly along x (Evan Wallace, "Fast Rounded
// Rectangle Shadows").
fn shadow_x(x : f32, y : f32, sigma : f32, corner : f32, h : vec2f) -> f32 {
  let delta = min(h.y - corner - abs(y), 0.0);
  let curved = h.x - corner + sqrt(max(0.0, corner * corner - delta * delta));
  let i = 0.5 + 0.5 * erf2((x + vec2f(-curved, curved)) * (0.70710678 / sigma));
  return i.y - i.x;
}

// Gaussian-blurred coverage of the rounded box (centre-relative p, half
// size h, per-corner radii r4) — numerical integration along y over +-3σ.
fn shadow_cov(p : vec2f, h : vec2f, r4 : vec4f, sigma : f32) -> f32 {
  let low = p.y - h.y;
  let high = p.y + h.y;
  let start = clamp(-3.0 * sigma, low, high);
  let end = clamp(3.0 * sigma, low, high);
  let n = 8.0;
  let st = (end - start) / n;
  var y = start + st * 0.5;
  var v = 0.0;
  for (var i = 0; i < 8; i = i + 1) {
    let row = p.y - y;
    let top = select(r4.x, r4.y, p.x > 0.0);
    let bot = select(r4.w, r4.z, p.x > 0.0);
    let corner = min(select(top, bot, row > 0.0), min(h.x, h.y));
    v = v + shadow_x(p.x, row, sigma, corner, h) * gaussian(y, sigma) * st;
    y = y + st;
  }
  return v;
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
  // Shadow records' quads are padded by sh0.y; pad = 0 for plain boxes.
  let d = sd_round_box(in.local, in.half - vec2f(b.sh0.y), b.radius);
  let aa = max(fwidth(d), 1e-4);
  let bw = b.bw; // top, right, bottom, left
  let opacity = b.params.y;

  // Derivatives must sit in uniform control flow: take the inner mask's
  // before branching.
  let ip = in.local + in.half - (b.sh1.xy + b.sh1.zw * 0.5);
  let di = sd_round_box(ip, b.sh1.zw * 0.5, b.shr);
  let aai = max(fwidth(di), 1e-4);
  if (b.sh0.z > 0.5 && b.sh0.w > 0.5) {
    // Inset: the quad is the padding box (pad = 0), kept inside by the
    // outer mask; the shadow is everything outside the blurred shadow box.
    let sigma = b.sh0.x;
    var inner = 1.0 - smoothstep(-aai, aai, di);
    if (sigma > 0.05) {
      inner = shadow_cov(ip, b.sh1.zw * 0.5, b.shr, sigma);
    }
    let keep = 1.0 - smoothstep(-aa, aa, d);
    let sa = b.fill.a * clamp(1.0 - inner, 0.0, 1.0) * keep;
    return vec4f(b.fill.rgb * sa, sa) * opacity;
  }
  if (b.sh0.z > 0.5) {
    let sigma = b.sh0.x;
    var cov = 1.0 - smoothstep(-aa, aa, d);
    if (sigma > 0.05) {
      cov = shadow_cov(in.local, in.half - vec2f(b.sh0.y), b.radius, sigma);
    }
    // Fully opaque from the border-box edge outward, so the element's own
    // AA edge pixel composites over full shadow (no background seam).
    let innerMask = smoothstep(-aai, aai, di + aai);
    let sa = b.fill.a * clamp(cov, 0.0, 1.0) * innerMask;
    return vec4f(b.fill.rgb * sa, sa) * opacity;
  }

  // Padding box: the border box inset per side, centre-relative.
  let half = in.half - vec2f(b.sh0.y);
  let ic = vec2f(bw.w - bw.y, bw.x - bw.z) * 0.5;
  let ih = max(half - vec2f(bw.w + bw.y, bw.x + bw.z) * 0.5, vec2f(0.0));
  // Inner radii (CSS: r minus the adjacent widths, a circular
  // approximation of the elliptical inner corner).
  let ir = max(b.radius - vec4f(max(bw.x, bw.w), max(bw.x, bw.y),
                                max(bw.z, bw.y), max(bw.z, bw.w)), vec4f(0.0));
  // Uniform widths: the outer SDF offset inward, as the ring always was.
  let uniform = all(bw.xxx == bw.yzw);
  let dIn = select(sd_round_box(in.local - ic, ih, ir), d + bw.x, uniform);
  let outerCov = 1.0 - smoothstep(-aa, aa, d);
  let fillCov  = 1.0 - smoothstep(-aa, aa, dIn);
  let borderCov = clamp(outerCov - fillCov, 0.0, 1.0);

  // Border side: the smallest distance into the ring, normalised by that
  // side's width — the CSS mitre from the outer to the inner corner.
  // Zero-width sides never win.
  let dist = vec4f(in.local.y + half.y, half.x - in.local.x,
                   half.y - in.local.y, in.local.x + half.x);
  let nd = select(dist / max(bw, vec4f(1e-6)), vec4f(1e9), bw <= vec4f(0.0));
  var bc = b.bc0;
  var best = nd.x;
  if (nd.y < best) { bc = b.bc1; best = nd.y; }
  if (nd.z < best) { bc = b.bc2; best = nd.z; }
  if (nd.w < best) { bc = b.bc3; }

  // Background: gradient over fill, source-over, kept premultiplied.
  var bgp = b.fill.rgb * b.fill.a;
  var bga = b.fill.a;
  if (b.grad.x > 0.5) {
    // Gradient box = padding box.
    let size = ih * 2.0;
    let gp = in.local - ic;
    var t = 0.0;
    if (b.grad.x < 1.5) {
      let ang = b.grad.y;
      let dir = vec2f(sin(ang), -cos(ang));
      let len = abs(size.x * sin(ang)) + abs(size.y * cos(ang));
      t = dot(gp, dir) / max(len, 1e-4) + 0.5;
    } else {
      let c = (b.gradc.xy - vec2f(0.5)) * size;
      t = length((gp - c) / max(b.gradc.zw, vec2f(1e-4)));
    }
    let g = gradient_at(t, u32(b.grad.z), u32(b.grad.w));
    bgp = g.rgb * g.a + bgp * (1.0 - g.a);
    bga = g.a + bga * (1.0 - g.a);
  }

  let rgb = (bgp * fillCov + bc.rgb * bc.a * borderCov) * opacity;
  let a = (bga * fillCov + bc.a * borderCov) * opacity;
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
    if (n <= this.capacity) {
      return false
    }
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
    if (need <= this.stopCapacity) {
      return false
    }
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
    if (this.count === 0) {
      return
    }
    let stopCount = 0
    for (const b of boxes) {
      stopCount += b.gradient?.stops.length ?? 0
    }
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
      const bd = b.border
      const top = bd?.colors[0]
      d[o++] = top?.r ?? 0
      d[o++] = top?.g ?? 0
      d[o++] = top?.b ?? 0
      d[o++] = top?.a ?? 0
      d[o++] = 0
      d[o++] = b.opacity
      d[o++] = b.z
      d[o++] = b.space === 'viewport' ? 1 : 0
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
        for (let k = 0; k < 8; k++) {
          d[o++] = 0
        }
      }
      const sh = b.shadow
      if (sh) {
        d[o++] = sh.blur * 0.5
        d[o++] = sh.inset ? 0 : shadowPad(sh.blur)
        d[o++] = 1
        d[o++] = sh.inset ? 1 : 0
        d[o++] = sh.inner.x
        d[o++] = sh.inner.y
        d[o++] = sh.inner.w
        d[o++] = sh.inner.h
        d[o++] = sh.inner.radius[0]
        d[o++] = sh.inner.radius[1]
        d[o++] = sh.inner.radius[2]
        d[o++] = sh.inner.radius[3]
      } else {
        for (let k = 0; k < 12; k++) {
          d[o++] = 0
        }
      }
      // Shadow records ignore `border`: zero widths keep the ring empty.
      for (let k = 0; k < 4; k++) {
        d[o++] = sh || !bd ? 0 : (bd.widths[k] ?? 0)
      }
      for (let k = 1; k < 4; k++) {
        const c = bd?.colors[k]
        d[o++] = c?.r ?? 0
        d[o++] = c?.g ?? 0
        d[o++] = c?.b ?? 0
        d[o++] = c?.a ?? 0
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
    this.stopBuffer?.destroy()
  }
}
