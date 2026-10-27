import type { LayoutMorph } from '@/fx'

declare global {
  interface Window {
    /** The layout morph playground (test/fx/run.ts drives it). */
    __layout?: {
      morph: LayoutMorph
      /** Per Next: capture() and settled() waits, ms. */
      results: { captureMs: number; settleMs: number }[]
      /** Morph to state `s` and hold it at `progress` (no play). */
      hold(s: number, progress: number): Promise<void>
      /** Set progress on the held morph. */
      at(progress: number): void
      /** End the held morph (the live page shows). */
      end(): void
    }
  }
}
