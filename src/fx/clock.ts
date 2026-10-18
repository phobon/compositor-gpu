// The effects clock: what `fx.time`, `fx.elapsed` and `fx.dt` read. It
// follows the frame's time, holds still under reduced motion (after the
// first frame, so effects still draw once), and gives way to the test
// harness's fixed values (effects.ts __override).

/** The clock's part of FxOverride (effects.ts). */
export interface ClockOverride {
  time?: number
  elapsed?: number
  dt?: number
}

export class EffectsClock {
  private ms = 0
  private set = false

  constructor(
    private readonly reduced: { readonly on: boolean },
    private readonly override: () => ClockOverride | null
  ) {}

  /** Move to the frame's time (ms) unless held. Call once per frame,
   * before anything reads the clock. */
  tick(frameMs: number): void {
    if (!this.reduced.on || !this.set) {
      this.ms = frameMs
      this.set = true
    }
  }

  /** The clock, ms. */
  nowMs(): number {
    return this.ms
  }

  /** `fx.time`, s: the clock, or the test override. */
  time(): number {
    return this.override()?.time ?? this.ms / 1000
  }

  /** Held still: reduced motion with no test time. Effects that only
   * change with time then have nothing new to draw. */
  held(): boolean {
    return this.reduced.on && this.override()?.time === undefined
  }

  /** `fx.elapsed`, s, for an effect whose clock started at `startMs`
   * (null: this frame). */
  elapsed(startMs: number | null): number {
    return this.override()?.elapsed ?? (this.ms - (startMs ?? this.ms)) / 1000
  }

  /** The simulate step override, s, or null. */
  dtOverride(): number | null {
    return this.override()?.dt ?? null
  }
}
