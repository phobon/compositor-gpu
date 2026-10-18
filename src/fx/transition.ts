import type { PostFrame } from '../gpu/graph'
import type { GpuTimer } from '../gpu/timer'
import { timed } from '../gpu/timer'
import { reportShaderErrors } from '../util/log'
import type { Pass, PassOptions } from './effects'
import type { ParamSchema } from './params'
import { FX_PREV_BYTES } from './shader'

// Transitions between two DOM states (fx.transition). capture() holds a
// copy of the visible viewport of the scene the post chain gets on the
// next frame; the pass then shows only that copy (`hold`) while the page
// swaps its DOM, until settled() finds the incoming page's mirror complete
// (fonts, image uploads, material compiles, viewport images loaded) on two
// frames running, or `timeout` passes. From then the author's fragment
// blends `prev(uv)` and `sample(uv)` by its own params (a `progress` the
// page tweens), and end() disables the pass and frees the copy. The copy
// is the scene before any pass runs; passes earlier in the chain apply to
// the incoming page only.

export interface TransitionOptions<S extends ParamSchema = ParamSchema>
  extends Omit<
    PassOptions<S>,
    'region' | 'image' | 'enabled' | 'downsample' | 'radius'
  > {
  /** ms settled() waits for the incoming mirror before giving up and
   * releasing the hold anyway. Default 1500 (as the replace-mode
   * handoff). */
  timeout?: number
}

export interface Transition<S extends ParamSchema = ParamSchema>
  extends Pass<S> {
  /** Enable the pass and hold a snapshot of the page as it is now; the
   * promise resolves once the snapshot is taken (swap the DOM then). */
  capture(): Promise<void>
  /** After the swap: resolves when the incoming page's mirror is
   * complete (or `timeout`), releasing the hold. Start `progress` then. */
  settled(): Promise<void>
  /** Disable the pass and free the snapshot. */
  end(): void
  /** True from capture() until settled() resolves. */
  readonly holding: boolean
}

/** Marks a PassOptions object as a transition's (internal). */
export const SNAPSHOT = Symbol('fx.snapshot')

const COPY_WGSL = /* wgsl */ `
struct Origin { o : vec2f, _p : vec2f };
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var<uniform> org : Origin;

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  return textureLoad(src, vec2i(pos.xy + org.o), 0);
}
`

export interface SnapshotDeps {
  device: GPUDevice
  format: GPUTextureFormat
  /** The pass's group-3 layout: texture, sampler, uniform. */
  layout: GPUBindGroupLayout
  sampler: GPUSampler
  timer: GpuTimer | null
  /** The mirror is complete as of this frame's read. */
  complete(): boolean
  wake(): void
}

/** A transition's held snapshot and its hold. */
export class Snapshot {
  want = false
  hold = false
  private texture: GPUTexture | null = null
  /** Bound before the first copy (and after end()). */
  private placeholder: GPUTexture | null = null
  private group: GPUBindGroup | null = null
  private bound: GPUTexture | null = null
  private readonly info: GPUBuffer
  private readonly data = new Float32Array(FX_PREV_BYTES / 4)
  private copy: GPURenderPipeline | null = null
  private readonly origin: GPUBuffer
  private copyGroup: GPUBindGroup | null = null
  private copyFrom: GPUTextureView | null = null
  private captured: (() => void)[] = []
  private waiting: {
    ok: number
    deadline: number
    done: Promise<void>
    resolve: () => void
  } | null = null

  constructor(
    private readonly d: SnapshotDeps,
    private readonly timeout: number
  ) {
    this.info = d.device.createBuffer({
      label: 'fx:snapshot',
      size: FX_PREV_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    this.origin = d.device.createBuffer({
      label: 'fx:snapshot-origin',
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
  }

  /** Waiting on a copy or on the incoming mirror (keeps the loop alive). */
  busy(): boolean {
    return this.want || this.waiting !== null
  }

  capture(): Promise<void> {
    this.want = true
    this.hold = true
    this.d.wake()
    return new Promise((r) => this.captured.push(r))
  }

  settled(): Promise<void> {
    if (!this.hold) {
      return Promise.resolve()
    }
    if (!this.waiting) {
      let resolve = (): void => {}
      const done = new Promise<void>((r) => {
        resolve = r
      })
      this.waiting = {
        ok: 0,
        deadline: performance.now() + this.timeout,
        done,
        resolve
      }
    }
    this.d.wake()
    return this.waiting.done
  }

  /** Each frame, after its DOM reads: release the hold once the mirror
   * has been complete on two frames running (the first one's uploads
   * have then been made), or at the deadline. */
  frame(): void {
    const w = this.waiting
    if (!w || this.want) {
      return
    }
    w.ok = this.d.complete() ? w.ok + 1 : 0
    if (w.ok >= 2 || performance.now() >= w.deadline) {
      this.release()
    }
  }

  /** Before the chain's stages: take the copy if one was asked for, and
   * write the hold. */
  encode(frame: PostFrame): void {
    const v = frame.viewport
    if (this.want) {
      this.take(frame)
      this.want = false
      const cbs = this.captured
      this.captured = []
      for (const cb of cbs) {
        cb()
      }
    }
    const t = this.texture
    this.data[0] = t?.width ?? v.width
    this.data[1] = t?.height ?? v.height
    this.data[2] = this.hold ? 1 : 0
    this.d.device.queue.writeBuffer(this.info, 0, this.data)
  }

  bind(rp: GPURenderPassEncoder): void {
    const t = this.texture ?? this.empty()
    if (t !== this.bound || !this.group) {
      this.bound = t
      this.group = this.d.device.createBindGroup({
        label: 'fx:snapshot',
        layout: this.d.layout,
        entries: [
          { binding: 0, resource: t.createView() },
          { binding: 1, resource: this.d.sampler },
          { binding: 2, resource: { buffer: this.info } }
        ]
      })
    }
    rp.setBindGroup(3, this.group)
  }

  /** Let go of the snapshot (and anything waiting on it). */
  end(): void {
    this.release()
    this.want = false
    const cbs = this.captured
    this.captured = []
    for (const cb of cbs) {
      cb()
    }
    this.texture?.destroy()
    this.texture = null
  }

  destroy(): void {
    this.end()
    this.placeholder?.destroy()
    this.placeholder = null
    this.info.destroy()
    this.origin.destroy()
  }

  private release(): void {
    this.hold = false
    const w = this.waiting
    this.waiting = null
    w?.resolve()
  }

  private create(w: number, h: number): GPUTexture {
    return this.d.device.createTexture({
      label: 'fx:snapshot',
      size: { width: w, height: h },
      format: this.d.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    })
  }

  private empty(): GPUTexture {
    this.placeholder ??= this.create(1, 1)
    return this.placeholder
  }

  /** The snapshot texture, w × h device px (the visible viewport). */
  private ensure(w: number, h: number): GPUTexture {
    const t = this.texture
    if (t && t.width === w && t.height === h) {
      return t
    }
    t?.destroy()
    this.texture = this.create(w, h)
    return this.texture
  }

  private take(frame: PostFrame): void {
    const { device, format } = this.d
    const v = frame.viewport
    const t = this.ensure(Math.max(1, v.width), Math.max(1, v.height))
    if (!this.copy) {
      const module = device.createShaderModule({
        label: 'fx:snapshot-copy',
        code: COPY_WGSL
      })
      reportShaderErrors(module, 'fx:snapshot-copy')
      this.copy = device.createRenderPipeline({
        label: 'fx:snapshot-copy',
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' }
      })
    }
    if (frame.scene !== this.copyFrom || !this.copyGroup) {
      this.copyFrom = frame.scene
      this.copyGroup = device.createBindGroup({
        layout: this.copy.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: frame.scene },
          { binding: 1, resource: { buffer: this.origin } }
        ]
      })
    }
    device.queue.writeBuffer(this.origin, 0, new Float32Array([v.x, v.y, 0, 0]))
    const rp = frame.encoder.beginRenderPass({
      label: 'fx:snapshot',
      ...timed(this.d.timer, 'fx:snapshot'),
      colorAttachments: [
        {
          view: t.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    })
    rp.setPipeline(this.copy)
    rp.setBindGroup(0, this.copyGroup)
    rp.draw(3)
    rp.end()
  }
}

/** A Transition over `pass` and its snapshot (null: inert, the promises
 * resolve at once). */
export function transitionHandle<S extends ParamSchema>(
  pass: Pass<S>,
  snap: Snapshot | null
): Transition<S> {
  const h = pass as Transition<S>
  return Object.defineProperties(h, {
    capture: {
      // Writable: presets wrap it (radialReveal sets its centre).
      writable: true,
      value: (): Promise<void> => {
        pass.enabled = true
        return snap ? snap.capture() : Promise.resolve()
      }
    },
    settled: {
      value: (): Promise<void> => snap?.settled() ?? Promise.resolve()
    },
    end: {
      value: (): void => {
        pass.enabled = false
        snap?.end()
      }
    },
    holding: { get: () => snap?.hold ?? false }
  })
}
