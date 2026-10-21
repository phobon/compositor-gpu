// Fade-in for images whose pixels arrive after the canvas is shown
// (CompositorOptions.imageFadeIn). A key is armed when its decode
// resolves; its fade starts at the first upload that draws it, so a frame
// spent waiting for the upload doesn't eat into the fade.

const easeOut = (t: number): number => t * (2 - t)

export class ImageFades {
  /** ms; 0 draws arriving images at once (and drops pending fades). */
  private ms = 0
  private starts = new Map<string, number | null>()

  get duration(): number {
    return this.ms
  }

  set duration(ms: number) {
    this.ms = Math.max(0, ms)
    if (this.ms === 0) {
      this.starts.clear()
    }
  }

  /** `key`'s pixels just arrived. */
  arm(key: string): void {
    if (this.ms > 0) {
      this.starts.set(key, null)
    }
  }

  /** `key`'s opacity factor for an upload at `now`. */
  alpha(key: string | undefined, now: number): number {
    if (key === undefined) {
      return 1
    }
    const start = this.starts.get(key)
    if (start === undefined) {
      return 1
    }
    if (start === null) {
      this.starts.set(key, now)
      return 0
    }
    const t = (now - start) / this.ms
    if (t >= 1) {
      this.starts.delete(key)
      return 1
    }
    return easeOut(t)
  }

  /** Some fade is armed or running (the image layer needs re-uploads). */
  get active(): boolean {
    return this.starts.size > 0
  }
}
