import type { EffectsClock } from './clock'

// What every effect kind with an on/off switch shares (passes, layers,
// materials, trails): `enabled` and `continuous` with their wake rules,
// the effect's own clock start, the destroyed flag, and what keeps the
// frame loop alive. Each kind supplies its own side effects (`toggled`,
// `busy`) and keeps its GPU work. Transforms and motions run on the
// composer instead (compose.ts).

export interface LifecycleOptions {
  enabled: boolean
  /** Whether it draws differently every frame; null when the kind has
   * no such flag (trails). */
  continuous: boolean | null
  /** Driven by the clock: a held clock (reduced motion) gives it nothing
   * new to draw, so it stops keeping the loop alive (passes, materials;
   * layers may still simulate). */
  timed: boolean
  /** Request a frame. */
  wake: () => void
  /** After `enabled` changed (on enable, after the clock reset), before
   * the wake. */
  toggled?: (on: boolean) => void
  /** Keeps the loop alive whatever else (a fading trail, a transition's
   * snapshot in progress). */
  busy?: () => boolean
}

export class Lifecycle {
  /** Assign directly only to switch off without side effects (runtime
   * teardown); handles go through setEnabled. */
  enabled: boolean
  continuous: boolean
  readonly hasContinuous: boolean
  readonly timed: boolean
  /** The clock (ms) when this enable's first frame ran; null until then. */
  enabledAt: number | null = null
  destroyed = false
  private inFrame = false

  constructor(private readonly o: LifecycleOptions) {
    this.enabled = o.enabled
    this.hasContinuous = o.continuous !== null
    this.continuous = o.continuous ?? false
    this.timed = o.timed
  }

  /** Switch on or off: restarts the clock on enable, runs the kind's
   * `toggled`, wakes the loop. Nothing when unchanged. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) {
      return
    }
    this.enabled = on
    if (on) {
      this.enabledAt = null
    }
    this.o.toggled?.(on)
    this.wake()
  }

  setContinuous(on: boolean): void {
    if (on === this.continuous) {
      return
    }
    this.continuous = on
    this.wake()
  }

  /** Request a frame, unless inside this effect's own frame (an update
   * hook's writes must not ask for another, or the loop never idles). */
  wake(): void {
    if (!this.inFrame) {
      this.o.wake()
    }
  }

  /** A param changed: a frame if it's showing. */
  paramsChanged(): void {
    if (this.enabled) {
      this.wake()
    }
  }

  /** Run `f` as this effect's frame (wakes from it are dropped). */
  inside<T>(f: () => T): T {
    this.inFrame = true
    try {
      return f()
    } finally {
      this.inFrame = false
    }
  }

  /** Start the effect's clock on its first frame after enabling. */
  start(clock: EffectsClock): void {
    this.enabledAt ??= clock.nowMs()
  }

  /** `fx.elapsed`, s. */
  elapsed(clock: EffectsClock): number {
    return clock.elapsed(this.enabledAt)
  }

  /** Mark destroyed; true the first time (run the kind's cleanup then). */
  destroy(): boolean {
    if (this.destroyed) {
      return false
    }
    this.destroyed = true
    return true
  }

  busy(): boolean {
    return this.o.busy?.() ?? false
  }
}

/** Any of `lives` switched on. */
export function anyEnabled(lives: Iterable<Lifecycle>): boolean {
  for (const l of lives) {
    if (l.enabled) {
      return true
    }
  }
  return false
}

/**
 * Whether the frame loop must keep running: something busy; an enabled
 * effect drawing differently every frame (a timed one only while the
 * clock runs); or an enabled one with a `continuous` flag while the
 * pointer moves (it may read the pointer).
 */
export function keepAlive(
  lives: Iterable<Lifecycle>,
  clock: EffectsClock,
  pointerMoving: () => boolean
): boolean {
  const all = [...lives]
  if (all.some((l) => l.busy())) {
    return true
  }
  const held = clock.held()
  let any = false
  for (const l of all) {
    if (!l.enabled || !l.hasContinuous) {
      continue
    }
    if (l.continuous && !(l.timed && held)) {
      return true
    }
    any = true
  }
  return any && pointerMoving()
}
