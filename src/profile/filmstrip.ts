// The filmstrip (docs/PROFILER.md, M6e): small pictures of what the
// compositor drew, taken every `interval` ms while the profiler samples
// (a recording or the flight recorder), so a recording shows what was on
// screen around each late frame. Each is the visible viewport's part of
// the canvas, copied in the frame's own task (before it's presented: a
// WebGPU canvas's current texture is readable only then) into a small
// 2D canvas; pictures are encoded (WebP, or PNG where the browser can't)
// only when a report is made. Off by default (profile.filmstrip(true)).

/** Where to copy the frame from: the canvas and the viewport's part of
 * it, device px. */
export interface FrameView {
  canvas: HTMLCanvasElement
  sx: number
  sy: number
  sw: number
  sh: number
  /** Painted under the picture (the canvas is transparent where the
   * page's own background shows through). */
  background?: string
}

/** A picture in a report: `at` ms after its origin, a data URL. */
export interface FilmFrame {
  at: number
  src: string
}

export interface FilmstripOptions {
  /** Picture width, CSS px (height follows the viewport). Default 160. */
  width?: number
  /** ms between pictures. Default 250. */
  interval?: number
}

interface Shot {
  at: number
  canvas: HTMLCanvasElement
}

export class Filmstrip {
  readonly width: number
  readonly interval: number
  private shots: Shot[] = []
  private spare: HTMLCanvasElement[] = []
  private last = -Infinity

  constructor(o: FilmstripOptions = {}) {
    this.width = Math.max(32, Math.round(o.width ?? 160))
    this.interval = Math.max(16, o.interval ?? 250)
  }

  /** Take a picture of the frame drawn at `at` if one is due. */
  frame(at: number, view: FrameView | null): void {
    if (
      !view ||
      at - this.last < this.interval ||
      view.sw <= 0 ||
      view.sh <= 0
    ) {
      return
    }
    this.last = at
    const h = Math.max(1, Math.round((this.width * view.sh) / view.sw))
    let c = this.spare.pop()
    if (!c) {
      c = document.createElement('canvas')
    }
    if (c.width !== this.width || c.height !== h) {
      c.width = this.width
      c.height = h
    }
    const g = c.getContext('2d')
    if (!g) {
      return
    }
    try {
      g.fillStyle = view.background ?? '#fff'
      g.fillRect(0, 0, c.width, h)
      g.drawImage(
        view.canvas,
        view.sx,
        view.sy,
        view.sw,
        view.sh,
        0,
        0,
        c.width,
        h
      )
    } catch {
      this.spare.push(c)
      return
    }
    this.shots.push({ at, canvas: c })
  }

  /** Let go of pictures before `from` (their canvases are reused). */
  trim(from: number): void {
    let k = 0
    while (k < this.shots.length && (this.shots[k]?.at ?? 0) < from) {
      k++
    }
    for (const s of this.shots.splice(0, k)) {
      this.spare.push(s.canvas)
    }
  }

  /** The pictures in [from, to], encoded, `at` relative to `origin`. */
  encode(from: number, to: number, origin: number): FilmFrame[] {
    return this.shots
      .filter((s) => s.at >= from && s.at <= to)
      .map((s) => {
        let src = s.canvas.toDataURL('image/webp', 0.7)
        if (!src.startsWith('data:image/webp')) {
          src = s.canvas.toDataURL('image/png')
        }
        return { at: s.at - origin, src }
      })
  }

  clear(): void {
    this.trim(Infinity)
    this.last = -Infinity
  }
}
