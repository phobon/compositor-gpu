import type { Morph } from '@/fx'

declare global {
  interface Window {
    /** The morph playground (test/fx/run.ts drives it). */
    __morph?: {
      morph: Morph
      /** Morph to STRINGS[i] and hold it at `progress` (no play). */
      hold(i: number, progress: number): Promise<void>
      /** Set progress on the held morph. */
      at(progress: number): void
      /** Capture the heading and hold an assemble or scatter at
       * `progress`. */
      pose(mode: 'assemble' | 'scatter', progress: number): Promise<void>
      /** End the held morph (the live text shows). */
      end(): void
    }
  }
}
