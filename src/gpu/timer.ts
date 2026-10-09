// GPU pass timing through the `timestamp-query` feature: each timed render
// pass writes a begin and an end timestamp, resolved into a buffer at the
// end of the frame's encoder and read back asynchronously (a frame or two
// later). Only runs while the profiler asks for it; costs nothing otherwise.
//
// Chrome quantises timestamps to 100 µs unless it runs with
// --enable-dawn-features=allow_unsafe_apis or
// --enable-webgpu-developer-features, so short passes read as 0 or 0.1 ms.

/** One timed render pass. */
export interface GpuSpan {
  label: string
  ms: number
}

/** A frame's GPU timings. */
export interface GpuFrameTiming {
  /** Renderer.frames when the frame was encoded. */
  frame: number
  spans: GpuSpan[]
  /** First pass begin to last pass end, ms. */
  totalMs: number
  /** Passes past MAX_SPANS, left untimed. */
  untimed: number
}

/** A render pass descriptor's `timestampWrites` member for `label`, or
 * nothing. Spread it in: the member must be absent, not undefined, when
 * untimed (SwiftShader's Dawn stalls on `timestampWrites: undefined`). */
export function timed(
  timer: GpuTimer | null,
  label: string
): { timestampWrites?: GPURenderPassTimestampWrites } {
  const w = timer?.writes(label)
  return w ? { timestampWrites: w } : {}
}

/** Timed passes per frame. */
const MAX_SPANS = 64
/** Readback buffers in flight; a frame finding none free goes untimed. */
const MAX_READBACKS = 4

export class GpuTimer {
  static supported(device: GPUDevice): boolean {
    return device.features.has('timestamp-query')
  }

  private readonly querySet: GPUQuerySet
  private readonly resolveBuffer: GPUBuffer
  private readonly free: GPUBuffer[] = []
  private readonly all: GPUBuffer[] = []
  private labels: string[] = []
  private open = false
  private frame = 0
  private untimed = 0
  private destroyed = false
  /** Readbacks still mapping. */
  pending = 0

  constructor(
    private readonly device: GPUDevice,
    private readonly onResult: (t: GpuFrameTiming) => void
  ) {
    this.querySet = device.createQuerySet({
      label: 'gpu-timer',
      type: 'timestamp',
      count: MAX_SPANS * 2
    })
    this.resolveBuffer = device.createBuffer({
      label: 'gpu-timer-resolve',
      size: MAX_SPANS * 2 * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
    })
  }

  /** Start timing a frame's passes (skipped when every readback is busy). */
  begin(frame: number): void {
    this.labels = []
    this.untimed = 0
    this.frame = frame
    this.open = this.free.length > 0 || this.all.length < MAX_READBACKS
  }

  /** Timestamp writes for a render pass labelled `label`, or undefined
   * when this frame isn't being timed. */
  writes(label: string): GPURenderPassTimestampWrites | undefined {
    if (!this.open) {
      return undefined
    }
    const i = this.labels.length
    if (i >= MAX_SPANS) {
      this.untimed++
      return undefined
    }
    this.labels.push(label)
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: i * 2,
      endOfPassWriteIndex: i * 2 + 1
    }
  }

  /** Resolve the frame's timestamps into `encoder` (before finish()).
   * Returns the function to call after submit, which reads them back. */
  end(encoder: GPUCommandEncoder): (() => void) | null {
    const n = this.labels.length * 2
    if (!this.open || n === 0) {
      this.open = false
      return null
    }
    this.open = false
    let buf = this.free.pop()
    if (!buf) {
      buf = this.device.createBuffer({
        label: 'gpu-timer-readback',
        size: MAX_SPANS * 2 * 8,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
      })
      this.all.push(buf)
    }
    encoder.resolveQuerySet(this.querySet, 0, n, this.resolveBuffer, 0)
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, buf, 0, n * 8)
    const labels = this.labels
    const frame = this.frame
    const untimed = this.untimed
    const target = buf
    return () => {
      this.pending++
      target.mapAsync(GPUMapMode.READ, 0, n * 8).then(
        () => {
          this.pending--
          if (this.destroyed) {
            return
          }
          const ts = new BigInt64Array(target.getMappedRange(0, n * 8))
          const spans: GpuSpan[] = []
          let first = 0n
          let last = 0n
          for (let i = 0; i < labels.length; i++) {
            const b = ts[i * 2] ?? 0n
            const e = ts[i * 2 + 1] ?? 0n
            spans.push({
              label: labels[i] ?? '',
              ms: e > b ? Number(e - b) / 1e6 : 0
            })
            if (b > 0n && (first === 0n || b < first)) {
              first = b
            }
            if (e > last) {
              last = e
            }
          }
          target.unmap()
          this.free.push(target)
          this.onResult({
            frame,
            spans,
            totalMs: last > first ? Number(last - first) / 1e6 : 0,
            untimed
          })
        },
        () => {
          // Destroyed or the device was lost.
          this.pending--
        }
      )
    }
  }

  destroy(): void {
    this.destroyed = true
    this.querySet.destroy()
    this.resolveBuffer.destroy()
    for (const b of this.all) {
      b.destroy()
    }
  }
}
