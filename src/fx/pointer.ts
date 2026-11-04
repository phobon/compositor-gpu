import * as d from 'typegpu/data'
import { floatOffsets, structWgsl } from '../gpu/schema'
import type { PointerClick, PointerState } from '../types'

// Pointer tracking for the effects layer: raw position (viewport + page),
// smoothed velocity, down state, an eased follower and a ring of the last
// CLICKS clicks. Uploaded as the `Pointer` uniform (group 2, binding 2).

export const CLICKS = 8

/** The Pointer uniform. */
export const PointerData = d
  .struct({
    /** Raw, viewport CSS px. */
    pos: d.vec2f,
    /** Raw, page CSS px. */
    page: d.vec2f,
    /** Raw velocity, CSS px/s. */
    vel: d.vec2f,
    /** Follower, viewport CSS px. */
    follow: d.vec2f,
    /** Follower velocity, CSS px/s. */
    follow_vel: d.vec2f,
    /** 1 while a button is down. */
    down: d.f32,
    /** 1 after the first pointer event. */
    seen: d.f32,
    /** Valid entries in `clicks`. */
    clicks_n: d.f32,
    _pad: d.f32,
    _pad2: d.vec2f,
    /** (x, y page CSS px, t s, _), newest first. */
    clicks: d.arrayOf(d.vec4f, CLICKS)
  })
  .$name('Pointer')

export const POINTER_BYTES = d.sizeOf(PointerData)
const AT = floatOffsets(PointerData)

export const POINTER_WGSL: string = structWgsl(PointerData)

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
    const v = this.data
    v[AT.pos] = p.x
    v[AT.pos + 1] = p.y
    v[AT.page] = p.pageX
    v[AT.page + 1] = p.pageY
    v[AT.vel] = p.vx
    v[AT.vel + 1] = p.vy
    v[AT.follow] = p.follow.x
    v[AT.follow + 1] = p.follow.y
    v[AT.follow_vel] = p.follow.vx
    v[AT.follow_vel + 1] = p.follow.vy
    v[AT.down] = p.down ? 1 : 0
    v[AT.seen] = p.seen ? 1 : 0
    v[AT.clicks_n] = Math.min(p.clicks.length, CLICKS)
    v.fill(0, AT._pad, AT.clicks)
    for (let i = 0; i < CLICKS; i++) {
      const c = p.clicks[i]
      const k = AT.clicks + i * 4
      v[k] = c?.x ?? 0
      v[k + 1] = c?.y ?? 0
      v[k + 2] = c?.t ?? 0
      v[k + 3] = 0
    }
    return v
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
