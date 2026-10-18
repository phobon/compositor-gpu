import type { Transition } from '@/fx'
import type { ProfileSummary } from '@/profile/profiler'

declare global {
  interface Window {
    /** The transition playground (test/transition/run.ts reads it). */
    __tr?: {
      done: boolean
      /** Per transition: capture() and settled() waits, ms. */
      results: { captureMs: number; settleMs: number }[]
      go(to: number, center: [number, number]): Promise<void>
      reveal: Transition
      /** ?auto: the frames during progress, summarised. */
      summary?: ProfileSummary
      /** ?auto: frames where the source DOM painted during progress. */
      shown?: number
    }
  }
}
