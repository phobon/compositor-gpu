import type { LayoutMorph } from '@/fx'

declare global {
  interface Window {
    /** The layout morph playground (test/fx/run.ts drives it). */
    __layout?: {
      morph: LayoutMorph
      /** Per Next: capture() and settled() waits, ms. */
      results: { captureMs: number; settleMs: number }[]
      /** Morph to state `s` and hold it at `progress` (no play); `from`:
       * scroll there first (with `?scroll`, the swap returns to the top). */
      hold(s: number, progress: number, from?: number): Promise<void>
      /** Set progress on the held morph. */
      at(progress: number): void
      /** End the held morph (the live page shows). */
      end(): void
      /** Play one swap (with or without the shockwave): capture()'s ms
       * and the played span (performance.now). */
      run(
        wave: boolean,
        ms: number
      ): Promise<{ captureMs: number; start: number; end: number }>
    }
  }
}
