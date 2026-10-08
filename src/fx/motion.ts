import { type Composer, type Contribution, identity } from './compose'
import type { ParamDef } from './params'
import type { Target } from './target'

// Motions: an element's layer transform moving from `from` to `to` as
// `progress` goes 0 -> 1 (docs/EFFECTS.md, Authoring). Timing is the
// caller's: GSAP or Motion set `progress` (src/fx/README.md recipes), or
// play()/reverse() run a basic built-in tween. Several motions and
// transforms on one element combine (compose.ts). Without WebGPU nothing
// renders; progress and params still work.

/** The animatable channels. `scale` multiplies `scaleX` and `scaleY`. */
export interface MotionValues {
  /** CSS px. */
  x: number
  y: number
  scale: number
  scaleX: number
  scaleY: number
  /** Degrees, clockwise. */
  rotate: number
  /** Multiplies the element's own opacity. */
  opacity: number
}

export type Bezier = [number, number, number, number]

export interface MotionOptions {
  /** Values at progress 0; unset channels are at rest. */
  from?: Partial<MotionValues>
  /** Values at progress 1; unset channels are at rest. */
  to?: Partial<MotionValues>
  /** cubic-bezier applied to progress. Default linear: when GSAP or Motion
   * eases the progress tween, leave this unset. */
  ease?: Bezier
  /** Default 0. */
  progress?: number
  /** Transform origin, fractions of the border box. Default 0.5, 0.5. */
  originX?: number
  originY?: number
  /** Default true. Off: this motion no longer contributes. */
  enabled?: boolean
}

export interface PlayOptions {
  /** Seconds for a full 0 -> 1 run (scaled by the distance left).
   * Default 0.6. */
  duration?: number
  /** Seconds. Default 0. */
  delay?: number
}

/** Tunable values, as dotted paths (`from.scale`, `ease`). */
export type MotionSchema = Record<string, ParamDef>

export interface Motion {
  readonly el: Element
  /** False on an inert runtime (no WebGPU). */
  readonly gpu: boolean
  /** 0..1 (not clamped). Writes re-evaluate the channels. */
  progress: number
  enabled: boolean
  /** Live values; writes apply at once. `from`/`to` hold every channel. */
  readonly params: {
    readonly from: MotionValues
    readonly to: MotionValues
    ease: Bezier
  }
  /** The channels given in `from`/`to` (both sides) and `ease`, with
   * ranges, for tuning UIs. */
  readonly schema: MotionSchema
  /** Tween progress to 1 with the built-in tween; resolves when done or
   * stopped. */
  play(opts?: PlayOptions): Promise<void>
  /** Tween progress to 0. */
  reverse(opts?: PlayOptions): Promise<void>
  /** Stop a running play()/reverse() where it is. */
  stop(): void
  /** Stop and release the element. */
  destroy(): void
}

const CHANNELS = [
  'x',
  'y',
  'scale',
  'scaleX',
  'scaleY',
  'rotate',
  'opacity'
] as const

const RANGE: Record<keyof MotionValues, [number, number]> = {
  x: [-400, 400],
  y: [-400, 400],
  scale: [0, 2],
  scaleX: [0, 2],
  scaleY: [0, 2],
  rotate: [-180, 180],
  opacity: [0, 1]
}

const LINEAR: Bezier = [0, 0, 1, 1]

const rest = (): MotionValues => ({
  x: 0,
  y: 0,
  scale: 1,
  scaleX: 1,
  scaleY: 1,
  rotate: 0,
  opacity: 1
})

/** CSS `cubic-bezier(x1, y1, x2, y2)` at `t` (0..1 outside clamps). */
export function cubicBezier([x1, y1, x2, y2]: Bezier, t: number): number {
  if (t <= 0) {
    return 0
  }
  if (t >= 1) {
    return 1
  }
  if (x1 === y1 && x2 === y2) {
    return t
  }
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sx = (u: number): number => ((ax * u + bx) * u + cx) * u
  // Newton on x(u) = t, then bisection if it stalls.
  let u = t
  for (let i = 0; i < 8; i++) {
    const err = sx(u) - t
    if (Math.abs(err) < 1e-6) {
      return ((ay * u + by) * u + cy) * u
    }
    const d = (3 * ax * u + 2 * bx) * u + cx
    if (Math.abs(d) < 1e-6) {
      break
    }
    u -= err / d
  }
  let lo = 0
  let hi = 1
  u = t
  for (let i = 0; i < 30; i++) {
    const x = sx(u)
    if (Math.abs(x - t) < 1e-6) {
      break
    }
    if (x < t) {
      lo = u
    } else {
      hi = u
    }
    u = (lo + hi) / 2
  }
  return ((ay * u + by) * u + cy) * u
}

export function createMotion(
  composer: Composer,
  gpu: boolean,
  target: Target | Element,
  opts: MotionOptions = {}
): Motion {
  const el = target instanceof Element ? target : target.el
  const c: Contribution = { v: identity(), enabled: opts.enabled ?? true }
  c.v.originX = opts.originX ?? 0.5
  c.v.originY = opts.originY ?? 0.5
  let progress = opts.progress ?? 0
  let destroyed = false
  let raf = 0
  let settle: (() => void) | null = null

  const evaluate = (): void => {
    if (destroyed) {
      return
    }
    const e = cubicBezier(params.ease, progress)
    // Outside 0..1 (a caller overshooting) extrapolate linearly.
    const k = progress < 0 || progress > 1 ? progress : e
    const at = (ch: keyof MotionValues): number =>
      from[ch] + (to[ch] - from[ch]) * k
    const v = c.v
    const s = at('scale')
    v.x = at('x')
    v.y = at('y')
    v.scaleX = s * at('scaleX')
    v.scaleY = s * at('scaleY')
    v.rotate = at('rotate')
    v.opacity = at('opacity')
    composer.update(el)
  }
  const live = <T extends object>(o: T): T =>
    new Proxy(o, {
      set(t, k, val) {
        ;(t as Record<string | symbol, unknown>)[k] = val
        evaluate()
        return true
      }
    })

  const from = live({ ...rest(), ...opts.from })
  const to = live({ ...rest(), ...opts.to })
  const params = live({
    from,
    to,
    ease: [...(opts.ease ?? LINEAR)] as Bezier
  })

  const schema: MotionSchema = {}
  const given = new Set<keyof MotionValues>([
    ...(Object.keys(opts.from ?? {}) as (keyof MotionValues)[]),
    ...(Object.keys(opts.to ?? {}) as (keyof MotionValues)[])
  ])
  for (const side of ['from', 'to'] as const) {
    for (const ch of CHANNELS) {
      if (given.has(ch)) {
        const [min, max] = RANGE[ch]
        schema[`${side}.${ch}`] = {
          type: 'f32',
          default: (side === 'from' ? from : to)[ch],
          min,
          max
        }
      }
    }
  }
  schema.ease = { type: 'vec4', default: [...params.ease], min: 0, max: 1 }

  const stop = (): void => {
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
    const s = settle
    settle = null
    s?.()
  }
  const tween = (goal: number, o: PlayOptions = {}): Promise<void> => {
    stop()
    if (destroyed) {
      return Promise.resolve()
    }
    const duration = Math.max(0, o.duration ?? 0.6) * 1000
    const delay = Math.max(0, o.delay ?? 0) * 1000
    const start = progress
    const span = Math.abs(goal - start) * duration
    return new Promise((resolve) => {
      settle = resolve
      let t0 = -1
      const step = (now: number): void => {
        if (t0 < 0) {
          t0 = now + delay
        }
        const t = span > 0 ? Math.min(1, Math.max(0, (now - t0) / span)) : 1
        handle.progress = start + (goal - start) * t
        if (t < 1) {
          raf = requestAnimationFrame(step)
        } else {
          raf = 0
          settle = null
          resolve()
        }
      }
      raf = requestAnimationFrame(step)
    })
  }

  const handle: Motion = {
    el,
    gpu,
    get progress() {
      return progress
    },
    set progress(p: number) {
      progress = p
      evaluate()
    },
    get enabled() {
      return c.enabled
    },
    set enabled(v: boolean) {
      if (v === c.enabled || destroyed) {
        return
      }
      c.enabled = v
      composer.update(el)
    },
    params,
    schema,
    play: (o) => tween(1, o),
    reverse: (o) => tween(0, o),
    stop,
    destroy() {
      if (destroyed) {
        return
      }
      stop()
      destroyed = true
      remove()
    }
  }
  const remove = composer.add(el, c)
  evaluate()
  return handle
}
