import type { CompositorStats } from '@/types'

export type MutateKind = 'text' | 'class' | 'append'

declare global {
  interface Window {
    __perf?: {
      ready: Promise<void>
      stats(): CompositorStats
      mutate(kind: MutateKind): void
      /** Force a full re-read, for the perf runner's full-read measurement. */
      invalidate(): void
      /** Enable/disable the fullscreen blur pass (compositor-gpu/fx). */
      setBlur(on: boolean): void
    }
  }
}
