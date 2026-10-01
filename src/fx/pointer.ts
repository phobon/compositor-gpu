import type { PointerClick, PointerState } from '../types'

// Pointer tracking for the effects layer: raw position (viewport + page),
// smoothed velocity, down state, an eased follower and a ring of the last
// CLICKS clicks. Uploaded as the `Pointer` uniform (group 2, binding 2):
//
//   struct Pointer {           // offset
//     pos        : vec2f,      //   0  raw, viewport CSS px
//     page       : vec2f,      //   8  raw, page CSS px
//     vel        : vec2f,      //  16  raw velocity, CSS px/s
//     follow     : vec2f,      //  24  follower, viewport CSS px
//     follow_vel : vec2f,      //  32  follower velocity, CSS px/s
//     down       : f32,        //  40  1 while a button is down
//     seen       : f32,        //  44  1 after the first pointer event
//     clicks_n   : f32,        //  48  valid entries in `clicks`
//     _pad       : f32,        //  52
//     _pad2      : vec2f,      //  56
//     clicks     : array<vec4f, 8>, // 64  (x, y page CSS px, t s, _), newest first
//   };                         // 192 bytes

export const CLICKS = 8
export const POINTER_BYTES = 192

export const POINTER_WGSL = /* wgsl */ `
struct Pointer {
  pos        : vec2f,
  page       : vec2f,
  vel        : vec2f,
  follow     : vec2f,
  follow_vel : vec2f,
  down       : f32,
  seen       : f32,
  clicks_n   : f32,
  _pad       : f32,
  _pad2      : vec2f,
  clicks     : array<vec4f, ${CLICKS}>,
};
`

/** Velocity smoothing time constant, s (about three 60 Hz frames). */
const VEL_TAU = 0.05
/** The follower is idle once within this many CSS px of the pointer. */
const SETTLE_PX = 0.1

/** Override for tests: fields given replace the tracked ones. */
export interface PointerOverride {
  x?: number
  y?: number
  down?: boolean
  follow?: { x: number; y: number }
  clicks?: PointerClick[]
}

export function emptyPointer(): PointerState {
  return {
    x: 0,
    y: 0,
    pageX: 0,
    pageY: 0,
    vx: 0,
    vy: 0,
    down: false,
    seen: false,
    follow: { x: 0, y: 0, vx: 0, vy: 0 },
    ease: 0.12,
    clicks: []
  }
}

export class PointerTracker {
  readonly state: PointerState = emptyPointer()
  /** Latest event position, viewport CSS px. */
  private rawX = 0
  private rawY = 0
  private lastX = 0
  private lastY = 0
  private readonly data = new Float32Array(POINTER_BYTES / 4)
  private listening = false

  /** `onInput` runs on every pointer event (the runtime requests a frame
   * from it while an effect is enabled). */
  constructor(private readonly onInput: () => void) {}

  private readonly onMove = (e: PointerEvent): void => {
    this.rawX = e.clientX
    this.rawY = e.clientY
    if (!this.state.seen) {
      this.state.seen = true
      this.lastX = this.rawX
      this.lastY = this.rawY
      this.state.x = this.rawX
      this.state.y = this.rawY
      this.state.follow.x = this.rawX
      this.state.follow.y = this.rawY
    }
    this.onInput()
  }

  private readonly onDown = (e: PointerEvent): void => {
    this.onMove(e)
    this.state.down = true
    const clicks = this.state.clicks
    clicks.unshift({
      x: e.clientX + window.scrollX,
      y: e.clientY + window.scrollY,
      t: performance.now() / 1000
    })
    if (clicks.length > CLICKS) {
      clicks.length = CLICKS
    }
  }

  private readonly onUp = (): void => {
    this.state.down = false
    this.onInput()
  }

  listen(): void {
    if (this.listening || typeof window === 'undefined') {
      return
    }
    this.listening = true
    const o = { passive: true }
    window.addEventListener('pointermove', this.onMove, o)
    window.addEventListener('pointerdown', this.onDown, o)
    window.addEventListener('pointerup', this.onUp, o)
    window.addEventListener('pointercancel', this.onUp, o)
    window.addEventListener('blur', this.onUp, o)
  }

  unlisten(): void {
    if (!this.listening) {
      return
    }
    this.listening = false
    window.removeEventListener('pointermove', this.onMove)
    window.removeEventListener('pointerdown', this.onDown)
    window.removeEventListener('pointerup', this.onUp)
    window.removeEventListener('pointercancel', this.onUp)
    window.removeEventListener('blur', this.onUp)
  }

  /** Advance one frame of `dt` seconds at scroll (sx, sy). */
  step(dt: number, sx: number, sy: number): void {
    const s = this.state
    s.x = this.rawX
    s.y = this.rawY
    s.pageX = s.x + sx
    s.pageY = s.y + sy
    if (dt > 0) {
      // Exponential smoothing of the per-frame velocity.
      const k = 1 - Math.exp(-dt / VEL_TAU)
      s.vx += ((s.x - this.lastX) / dt - s.vx) * k
      s.vy += ((s.y - this.lastY) / dt - s.vy) * k
      // `ease` is per 60 Hz frame: the same fraction per 1/60 s at any
      // frame rate.
      const e = Math.min(Math.max(s.ease, 0), 1)
      const f = 1 - (1 - e) ** (dt * 60)
      const fx = s.follow.x
      const fy = s.follow.y
      s.follow.x += (s.x - fx) * f
      s.follow.y += (s.y - fy) * f
      s.follow.vx = (s.follow.x - fx) / dt
      s.follow.vy = (s.follow.y - fy) / dt
      if (!this.moving()) {
        s.follow.x = s.x
        s.follow.y = s.y
        s.follow.vx = 0
        s.follow.vy = 0
      }
    }
    this.lastX = s.x
    this.lastY = s.y
  }

  /** The follower is still catching up, or velocity hasn't decayed. */
  moving(): boolean {
    const s = this.state
    return (
      Math.hypot(s.x - s.follow.x, s.y - s.follow.y) > SETTLE_PX ||
      Math.hypot(s.vx, s.vy) > 1
    )
  }

  /** Pack `p` (the tracked state, or an override applied to it) into the
   * uniform layout above. */
  pack(p: PointerState): Float32Array {
    const d = this.data
    d[0] = p.x
    d[1] = p.y
    d[2] = p.pageX
    d[3] = p.pageY
    d[4] = p.vx
    d[5] = p.vy
    d[6] = p.follow.x
    d[7] = p.follow.y
    d[8] = p.follow.vx
    d[9] = p.follow.vy
    d[10] = p.down ? 1 : 0
    d[11] = p.seen ? 1 : 0
    d[12] = Math.min(p.clicks.length, CLICKS)
    d.fill(0, 13, 16)
    for (let i = 0; i < CLICKS; i++) {
      const c = p.clicks[i]
      d[16 + i * 4] = c?.x ?? 0
      d[17 + i * 4] = c?.y ?? 0
      d[18 + i * 4] = c?.t ?? 0
      d[19 + i * 4] = 0
    }
    return d
  }
}

/** `base` with `o`'s fields applied (velocities zero: an override is a
 * still pointer). */
export function applyOverride(
  base: PointerState,
  o: PointerOverride,
  sx: number,
  sy: number
): PointerState {
  const x = o.x ?? base.x
  const y = o.y ?? base.y
  const follow = o.follow ?? { x, y }
  return {
    ...base,
    x,
    y,
    pageX: x + sx,
    pageY: y + sy,
    vx: 0,
    vy: 0,
    down: o.down ?? base.down,
    seen: true,
    follow: { x: follow.x, y: follow.y, vx: 0, vy: 0 },
    clicks: o.clicks ?? base.clicks
  }
}
