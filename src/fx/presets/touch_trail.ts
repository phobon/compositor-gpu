import type { Trail } from '../trail'

// Feeds a trail from touch, where its own pointer tracking should be off
// (touch moves are scrolls). A finger's path leaves a trail, scrolling
// drags included: touch events keep arriving while the browser pans,
// unlike pointer events, which it cancels. A tap leaves a radial burst of
// `spokes` strokes. One finger at a time. `params` is read on every event,
// so it can be changed live.

const schema = {
  drag: { type: 'f32', default: 1, min: 0, max: 4 },
  tap: { type: 'f32', default: 56, min: 0, max: 200 },
  tapSpeed: { type: 'f32', default: 2400, min: 100, max: 6000 },
  spokes: { type: 'f32', default: 6, min: 0, max: 16 },
  tapMs: { type: 'f32', default: 250, min: 50, max: 1000 }
} as const

export type TouchTrailSchema = typeof schema

export interface TouchTrailParams {
  /** Scales a finger's speed. Default 1. */
  drag: number
  /** A tap's stroke length, CSS px. Default 56. */
  tap: number
  /** A tap's stroke speed, CSS px/s. Default 2400. */
  tapSpeed: number
  /** Strokes per tap. Default 6. */
  spokes: number
  /** Longest touch that counts as a tap, ms (also under 10 px of
   * movement). Default 250. */
  tapMs: number
}

export interface TouchTrail {
  readonly params: TouchTrailParams
  readonly schema: TouchTrailSchema
  destroy(): void
}

type Point = { x: number; y: number; t: number }

export function touchTrail(
  trail: Trail,
  opts: Partial<TouchTrailParams> = {}
): TouchTrail {
  const params: TouchTrailParams = {
    drag: schema.drag.default,
    tap: schema.tap.default,
    tapSpeed: schema.tapSpeed.default,
    spokes: schema.spokes.default,
    tapMs: schema.tapMs.default,
    ...opts
  }
  let id: number | null = null
  let last: Point | null = null
  let start: Point | null = null
  let moved = 0

  const find = (list: TouchList): Touch | null => {
    for (const t of Array.from(list)) {
      if (t.identifier === id) {
        return t
      }
    }
    return null
  }
  const onStart = (e: TouchEvent): void => {
    const t = e.changedTouches[0]
    if (id !== null || !t) {
      return
    }
    id = t.identifier
    last = start = { x: t.clientX, y: t.clientY, t: e.timeStamp }
    moved = 0
  }
  const onMove = (e: TouchEvent): void => {
    const t = find(e.changedTouches)
    if (!t || !last) {
      return
    }
    const p = { x: t.clientX, y: t.clientY, t: e.timeStamp }
    const d = Math.hypot(p.x - last.x, p.y - last.y)
    const dt = Math.max(p.t - last.t, 1) / 1000
    moved += d
    if (d > 0.5) {
      trail.stroke(last, p, (d / dt) * params.drag)
    }
    last = p
  }
  const onEnd = (e: TouchEvent): void => {
    if (!find(e.changedTouches)) {
      return
    }
    if (
      e.type === 'touchend' &&
      start &&
      moved < 10 &&
      e.timeStamp - start.t < params.tapMs
    ) {
      const a = Math.random() * Math.PI
      const n = Math.round(params.spokes)
      for (let i = 0; i < n; i++) {
        const r = a + (i / n) * Math.PI * 2
        trail.stroke(
          start,
          {
            x: start.x + Math.cos(r) * params.tap,
            y: start.y + Math.sin(r) * params.tap
          },
          params.tapSpeed
        )
      }
    }
    id = null
    last = start = null
  }

  const opt = { passive: true } as const
  window.addEventListener('touchstart', onStart, opt)
  window.addEventListener('touchmove', onMove, opt)
  window.addEventListener('touchend', onEnd, opt)
  window.addEventListener('touchcancel', onEnd, opt)
  return {
    params,
    schema,
    destroy() {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }
}
