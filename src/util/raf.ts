/**
 * Coalesced requestAnimationFrame scheduler: many requests in one frame run the
 * callback once. Carries dt/time so passes don't each call performance.now().
 */
export class FrameScheduler {
  private handle = 0
  private last = 0
  private running = false

  constructor(private readonly onFrame: (time: number, dt: number) => void) {}

  request(): void {
    if (this.handle || !this.running) {
      return
    }
    this.handle = requestAnimationFrame(this.tick)
  }

  start(): void {
    this.running = true
    this.last = performance.now()
    this.request()
  }

  stop(): void {
    this.running = false
    if (this.handle) {
      cancelAnimationFrame(this.handle)
    }
    this.handle = 0
  }

  private tick = (time: number): void => {
    this.handle = 0
    const dt = this.last ? (time - this.last) / 1000 : 0
    this.last = time
    this.onFrame(time, dt)
  }
}
