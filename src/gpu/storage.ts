// A growable storage buffer of fixed-size items and its CPU-side copy:
// the instance buffers of the record passes. Grows by doubling (at least
// to `n`) and is recreated whole, so a pass rebuilds the bind groups that
// reference it when `ensure` reports it grew.

/** What StorageArray needs of a GPUDevice. */
export interface StorageDevice {
  createBuffer(desc: GPUBufferDescriptor): GPUBuffer
  readonly queue: { writeBuffer: GPUQueue['writeBuffer'] }
}

export class StorageArray {
  /** Null until the first `ensure`. */
  buffer: GPUBuffer | null = null
  /** The CPU copy, viewed as floats and as words (the same bytes). */
  bytes = new ArrayBuffer(0)
  f32 = new Float32Array(0)
  u32 = new Uint32Array(0)
  private cap = 0

  /** `floats` per item; `initial` items on the first allocation. */
  constructor(
    private readonly device: StorageDevice,
    private readonly floats: number,
    private readonly initial: number,
    private readonly label?: string
  ) {}

  /** Items the buffer holds. */
  get capacity(): number {
    return this.cap
  }

  /** Room for `n` items; true when the buffer was (re)created, which
   * replaces `buffer` and the CPU copy (zeroed). */
  ensure(n: number): boolean {
    if (n <= this.cap && this.buffer) {
      return false
    }
    const cap = Math.max(n, this.cap ? this.cap * 2 : this.initial)
    this.buffer?.destroy()
    this.buffer = this.device.createBuffer({
      ...(this.label ? { label: this.label } : {}),
      size: cap * this.floats * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.bytes = new ArrayBuffer(cap * this.floats * 4)
    this.f32 = new Float32Array(this.bytes)
    this.u32 = new Uint32Array(this.bytes)
    this.cap = cap
    return true
  }

  /** Upload items [first, first + count) of the CPU copy. */
  write(first: number, count: number): void {
    if (!this.buffer || count <= 0) {
      return
    }
    const at = first * this.floats * 4
    this.device.queue.writeBuffer(
      this.buffer,
      at,
      this.bytes,
      at,
      count * this.floats * 4
    )
  }

  destroy(): void {
    this.buffer?.destroy()
    this.buffer = null
    this.cap = 0
  }
}
