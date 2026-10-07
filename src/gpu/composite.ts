import { reportShaderErrors } from '../util/log'
import { FRAME_WGSL, type Shared } from './frame'

// Opacity-group compositing: an offscreen texture pool plus a pipeline that
// draws a group's texture back into its parent target as one textured quad,
// scaled by the group alpha. The quad is the group's doc-space rect, or its
// image under a layer transform (a parallelogram: four corners).

/** Floats per composite instance: corners(8) + uv(4). */
const FLOATS_PER_COMP = 12
const BYTES_PER_COMP = FLOATS_PER_COMP * 4
/** Texture sizes are rounded up to this many device px, for reuse. */
const SIZE_STEP = 64
/** Pool textures unused for this many frames are destroyed. */
const EVICT_FRAMES = 120

/** The corners of a doc-space rect (minX, minY, maxX, maxY), for draw. */
export function rectQuad(r: readonly number[]): number[] {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = r
  return [x0, y0, x1, y0, x0, y1, x1, y1]
}

export const COMPOSITE_WGSL = /* wgsl */ `
${FRAME_WGSL}

struct Comp {
  c01  : vec4f,   // doc-space corners: top-left, top-right
  c23  : vec4f,   // bottom-left, bottom-right
  uv   : vec4f,   // u, v extent of the used region; alpha; _
};
@group(1) @binding(0) var<storage, read> comps : array<Comp>;
@group(1) @binding(1) var src : texture_2d<f32>;
@group(1) @binding(2) var samp : sampler;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
  @location(1) @interpolate(flat) alpha : f32,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32,
      @builtin(instance_index) ii : u32) -> VOut {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  var at = array<u32, 6>(0u, 1u, 2u, 2u, 1u, 3u);
  let c = comps[ii];
  let k = corners[vi];
  let q = array<vec2f, 4>(c.c01.xy, c.c01.zw, c.c23.xy, c.c23.zw);
  var out : VOut;
  out.pos = doc_to_clip(q[at[vi]]);
  out.uv = k * c.uv.xy;
  out.alpha = c.uv.z;
  return out;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  // The group texture is already premultiplied.
  let t = textureSample(src, samp, in.uv);
  return vec4f(t.rgb * in.alpha, t.a * in.alpha);
}
`

/** A pooled offscreen render target. */
export interface GroupTarget {
  texture: GPUTexture
  view: GPUTextureView
  /** Allocated size in device px (>= the used region). */
  width: number
  height: number
  /** Bind group 1 for compositing this texture (null until built). */
  bindGroup: GPUBindGroup | null
  inUse: boolean
  lastUsed: number
}

export class GroupCompositor {
  private readonly device: GPUDevice
  private readonly pipeline: GPURenderPipeline
  private readonly layout: GPUBindGroupLayout
  private readonly sampler: GPUSampler
  private buffer: GPUBuffer | null = null
  private capacity = 0
  private readonly data: number[] = []
  private readonly pool: GroupTarget[] = []
  private frame = 0

  constructor(private readonly shared: Shared) {
    const { device, format, frameLayout } = shared
    this.device = device
    this.layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
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
          sampler: { type: 'filtering' }
        }
      ]
    })
    const module = device.createShaderModule({
      label: 'composite',
      code: COMPOSITE_WGSL
    })
    reportShaderErrors(module, 'composite')
    this.pipeline = device.createRenderPipeline({
      label: 'composite',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [frameLayout, this.layout]
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
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge'
    })
  }

  /**
   * Start a frame that composites at most `maxGroups` groups: size the
   * instance buffer up front (growing it mid-frame would invalidate bind
   * groups already recorded), forget last frame's instances, and evict
   * stale targets.
   */
  begin(maxGroups: number): void {
    this.frame++
    this.data.length = 0
    if (this.ensureCapacity(maxGroups)) {
      for (const t of this.pool) {
        t.bindGroup = null
      }
    }
    for (let i = this.pool.length - 1; i >= 0; i--) {
      const t = this.pool[i]
      if (t && this.frame - t.lastUsed > EVICT_FRAMES) {
        t.texture.destroy()
        this.pool.splice(i, 1)
      }
    }
  }

  /** The smallest free pooled target of at least w×h device px. */
  acquire(w: number, h: number): GroupTarget {
    let best: GroupTarget | null = null
    for (const t of this.pool) {
      if (t.inUse || t.width < w || t.height < h) {
        continue
      }
      if (!best || t.width * t.height < best.width * best.height) {
        best = t
      }
    }
    if (!best) {
      const width = Math.ceil(w / SIZE_STEP) * SIZE_STEP
      const height = Math.ceil(h / SIZE_STEP) * SIZE_STEP
      const texture = this.device.createTexture({
        label: 'opacity-group',
        size: { width, height },
        format: this.shared.format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      })
      best = {
        texture,
        view: texture.createView(),
        width,
        height,
        bindGroup: null,
        inUse: false,
        lastUsed: this.frame
      }
      this.pool.push(best)
    }
    best.inUse = true
    best.lastUsed = this.frame
    return best
  }

  /** Release `target` for reuse without compositing it (a region handler
   * drew it instead). */
  release(target: GroupTarget): void {
    target.inUse = false
  }

  /**
   * Record a composite of `target`'s top-left `w`×`h` device px onto the
   * doc-space `quad` of the parent pass `rp` (corners top-left, top-right,
   * bottom-left, bottom-right as x, y pairs; see rectQuad), and release
   * the target for reuse by later (non-overlapping-in-time) groups.
   * Instance data is uploaded by flush(), before submit.
   */
  draw(
    rp: GPURenderPassEncoder,
    target: GroupTarget,
    quad: readonly number[],
    w: number,
    h: number,
    alpha: number
  ): void {
    const index = this.data.length / FLOATS_PER_COMP
    const buffer = this.buffer
    target.inUse = false
    if (!buffer || index >= this.capacity) {
      return
    }
    this.data.push(...quad, w / target.width, h / target.height, alpha, 0)
    if (!target.bindGroup) {
      target.bindGroup = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: target.view },
          { binding: 2, resource: this.sampler }
        ]
      })
    }
    rp.setPipeline(this.pipeline)
    rp.setBindGroup(1, target.bindGroup)
    rp.draw(6, 1, 0, index)
  }

  /** Upload this frame's composite instances. Call before submit. */
  flush(): void {
    if (this.data.length === 0 || !this.buffer) {
      return
    }
    this.device.queue.writeBuffer(this.buffer, 0, new Float32Array(this.data))
  }

  /** Grow the instance buffer; true when it was recreated. */
  private ensureCapacity(n: number): boolean {
    if (n <= this.capacity && this.buffer) {
      return false
    }
    let cap = Math.max(this.capacity, 4)
    while (cap < n) {
      cap *= 2
    }
    this.buffer?.destroy()
    this.buffer = this.device.createBuffer({
      label: 'composite-instances',
      size: cap * BYTES_PER_COMP,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.capacity = cap
    return true
  }

  destroy(): void {
    for (const t of this.pool) {
      t.texture.destroy()
    }
    this.pool.length = 0
    this.buffer?.destroy()
  }
}
