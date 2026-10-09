import type { ProfileReport } from '@/profile/profiler'
import type { Compositor, CompositorStats } from '@/types'

export type MutateKind = 'text' | 'class' | 'append'

declare global {
  interface Window {
    /** The compositor (test/profile/run.ts drives its profiler). */
    __gpu?: Compositor
    __perf?: {
      /** Record scenario `name` (test/profile/run.ts SCENARIOS), its
       * frame counts scaled by `frames` (default 1). */
      scenario(name: string, frames?: number): Promise<ProfileReport | null>
      ready: Promise<void>
      stats(): CompositorStats
      mutate(kind: MutateKind): void
      /** Force a full re-read, for the perf runner's full-read measurement. */
      invalidate(): void
      /** Enable/disable the fullscreen blur pass (compositor-gpu/fx). */
      setBlur(on: boolean): void
      /** Animate up to 30 cards in view for `frames` frames via CSS
       * transforms ('dom') or fx.transform ('gpu'). */
      animate(
        mode: 'dom' | 'gpu',
        frames: number
      ): Promise<{ cards: number; frameMs: number[]; cpuMs: number[] }>
    }
  }
}
