import { type Bezier, cubicBezier } from './motion'

// Tweens for config triggers (config.ts, docs/EDITOR.md). Each channel
// (one param as number[]) moves from its current value to a goal, by a
// cubic-bezier over a duration or by a spring. A new goal for a channel
// that is still moving starts from where it is; a spring keeps its
// velocity, which a bezier channel estimates each step. Pure: the
// caller passes `now` (ms) and drives step().

export interface Spring {
  /** Seconds to visually settle. Default 0.3. */
  visualDuration?: number
  /** 0 (no overshoot) .. 1. Default 0. */
  bounce?: number
}

export type Ease = Bezier | { spring: Spring }

export interface Timing {
  /** Seconds, for a bezier. Default 0.4. */
  duration?: number
  /** Seconds. Default 0. */
  delay?: number
  /** Default CSS `ease`. */
  ease?: Ease
}

export const DEFAULT_DURATION = 0.4
export const DEFAULT_EASE: Bezier = [0.25, 0.1, 0.25, 1]

/** Spring step size, s. */
const H = 1 / 240
/** Steps integrated per step() at most (a hidden tab): then it lands. */
const MAX_STEPS = 960

/** Stiffness and damping (mass 1) for a spring given as visual duration
 * and bounce (Motion's conversion). */
export function springCoefficients(s: Spring): { k: number; c: number } {
  const vd = Math.max(0.01, s.visualDuration ?? 0.3)
  const root = (2 * Math.PI) / (vd * 1.2)
  const bounce = Math.min(1, Math.max(0, s.bounce ?? 0))
  return { k: root * root, c: 2 * (1 - bounce) * root }
}

interface Group {
  pending: Set<string>
  done: (() => void) | undefined
  dropped: boolean
}

interface Channel {
  from: number[]
  to: number[]
  cur: number[]
  vel: number[]
  /** ms, after the delay. */
  start: number
  /** ms; bezier only. */
  dur: number
  bezier: Bezier | null
  k: number
  c: number
  /** ms of the last step. */
  last: number
  group: Group
}

export class Animator {
  private readonly chans = new Map<string, Channel>()

  constructor(private readonly write: (key: string, v: number[]) => void) {}

  get running(): boolean {
    return this.chans.size > 0
  }

  /** The value a channel is at while it moves, else undefined. */
  value(key: string): readonly number[] | undefined {
    return this.chans.get(key)?.cur
  }

  /**
   * Move each key of `goals` from its current value (`current(key)`, or
   * where its running channel is) to the goal. `done` runs once every
   * channel of this call has landed, and not at all when a later call
   * takes one of them over or stop() removes it. Duration 0 (bezier)
   * writes the goals at once.
   */
  to(
    goals: Readonly<Record<string, readonly number[]>>,
    current: (key: string) => readonly number[],
    t: Timing,
    now: number,
    done?: () => void
  ): void {
    const ease = t.ease ?? DEFAULT_EASE
    const spring = 'spring' in ease ? springCoefficients(ease.spring) : null
    const dur = Math.max(0, t.duration ?? DEFAULT_DURATION) * 1000
    const start = now + Math.max(0, t.delay ?? 0) * 1000
    const group: Group = { pending: new Set(), done, dropped: false }
    const instant = !spring && dur === 0 && start <= now
    for (const [key, goal] of Object.entries(goals)) {
      const old = this.chans.get(key)
      if (old) {
        old.group.dropped = true
        this.chans.delete(key)
      }
      if (instant) {
        this.write(key, [...goal])
        continue
      }
      const cur = [...(old?.cur ?? current(key))]
      group.pending.add(key)
      this.chans.set(key, {
        from: [...cur],
        to: [...goal],
        cur,
        vel: old ? [...old.vel] : cur.map(() => 0),
        start,
        dur,
        bezier: spring ? null : (ease as Bezier),
        k: spring?.k ?? 0,
        c: spring?.c ?? 0,
        last: now,
        group
      })
    }
    if (group.pending.size === 0) {
      done?.()
    }
  }

  /** Advance to `now`; true while a channel still moves. */
  step(now: number): boolean {
    for (const [key, ch] of this.chans) {
      if (now <= ch.start) {
        ch.last = now
        continue
      }
      const landed = ch.bezier ? this.bezier(ch, now) : this.spring(ch, now)
      ch.last = now
      if (landed) {
        this.chans.delete(key)
        this.write(key, [...ch.to])
        const g = ch.group
        g.pending.delete(key)
        if (g.pending.size === 0 && !g.dropped) {
          g.done?.()
        }
      } else {
        this.write(key, [...ch.cur])
      }
    }
    return this.chans.size > 0
  }

  /** Stop `key` (or every channel) where it is, without its done. */
  stop(key?: string): void {
    for (const [k, ch] of this.chans) {
      if (key === undefined || k === key) {
        ch.group.dropped = true
        this.chans.delete(k)
      }
    }
  }

  private bezier(ch: Channel, now: number): boolean {
    const t = ch.dur > 0 ? (now - ch.start) / ch.dur : 1
    const p = cubicBezier(ch.bezier as Bezier, t)
    const dt = Math.max(1e-3, (now - Math.max(ch.last, ch.start)) / 1000)
    for (let i = 0; i < ch.cur.length; i++) {
      const a = ch.from[i] ?? 0
      const v = a + ((ch.to[i] ?? 0) - a) * p
      ch.vel[i] = (v - (ch.cur[i] ?? 0)) / dt
      ch.cur[i] = v
    }
    return t >= 1
  }

  private spring(ch: Channel, now: number): boolean {
    let steps = Math.round((now - Math.max(ch.last, ch.start)) / 1000 / H)
    if (steps > MAX_STEPS) {
      return true
    }
    let span = 0
    for (let i = 0; i < ch.cur.length; i++) {
      span = Math.max(span, Math.abs((ch.to[i] ?? 0) - (ch.from[i] ?? 0)))
    }
    const eps = Math.max(1e-4, span * 1e-3)
    for (; steps > 0; steps--) {
      for (let i = 0; i < ch.cur.length; i++) {
        const x = ch.cur[i] ?? 0
        const v = ch.vel[i] ?? 0
        const nv = v + (-ch.k * (x - (ch.to[i] ?? 0)) - ch.c * v) * H
        ch.vel[i] = nv
        ch.cur[i] = x + nv * H
      }
    }
    for (let i = 0; i < ch.cur.length; i++) {
      const off = Math.abs((ch.cur[i] ?? 0) - (ch.to[i] ?? 0))
      if (off > eps || Math.abs(ch.vel[i] ?? 0) > eps * 10) {
        return false
      }
    }
    return true
  }
}
