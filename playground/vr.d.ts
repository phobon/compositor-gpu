import type { CompositorStats } from '@/types'

declare global {
  interface Window {
    __vr?: {
      ready: Promise<void>
      setMode(mode: 'dom' | 'gpu' | 'both'): Promise<void>
      stats(): CompositorStats
      /** Force a full re-read (for changes outside the mirrored root). */
      invalidate(): void
    }
  }
}
