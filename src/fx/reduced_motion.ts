// The viewer's reduced-motion preference (`prefers-reduced-motion:
// reduce`), live, with an override (Effects.reducedMotion). While it is on,
// the effects clock holds still, so anything driven by `fx.time` or
// `fx.elapsed` stops moving, and Motion.play()/reverse() jump to their end.
// Timing the site drives itself (GSAP, Motion) is the site's to gate.

const QUERY = '(prefers-reduced-motion: reduce)'

export interface ReducedMotion {
  /** The effective value: the override, else the system preference. */
  readonly on: boolean
  /** null follows the system preference. */
  override: boolean | null
  /** Called with the effective value whenever it changes. */
  subscribe(cb: (on: boolean) => void): () => void
  destroy(): void
}

export function createReducedMotion(): ReducedMotion {
  const mq =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(QUERY)
      : null
  let system = mq?.matches ?? false
  let override: boolean | null = null
  let last = system
  const subs = new Set<(on: boolean) => void>()
  const value = (): boolean => override ?? system
  const notify = (): void => {
    const v = value()
    if (v === last) {
      return
    }
    last = v
    for (const cb of [...subs]) {
      cb(v)
    }
  }
  const onChange = (e: MediaQueryListEvent): void => {
    system = e.matches
    notify()
  }
  mq?.addEventListener('change', onChange)
  return {
    get on() {
      return value()
    },
    get override() {
      return override
    },
    set override(v: boolean | null) {
      override = v
      notify()
    },
    subscribe(cb) {
      subs.add(cb)
      return () => {
        subs.delete(cb)
      }
    },
    destroy() {
      mq?.removeEventListener('change', onChange)
      subs.clear()
    }
  }
}
