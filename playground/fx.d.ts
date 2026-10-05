import type { Effects, Layer, Pass } from '@/fx'
import type { CompositorStats } from '@/types'

declare global {
  interface Window {
    __fx?: {
      ready: Promise<void>
      fx: Effects
      blur: Pass
      displace: Pass
      /** A tgpu.fn fragment (premultiplied invert). */
      tgpu: Pass
      glow: Layer
      ripple: Layer
      /** blur on #region-card only. */
      region: Pass
      /** A quad drawn right after #after-anchor. */
      after: Layer
      /** Pin two clicks around the viewport centre (fx.__override). */
      pinClicks(): void
      setMode(mode: 'dom' | 'gpu' | 'both'): Promise<void>
      stats(): CompositorStats
      /** Stop / restart the compositor's frame loop (the scissor check
       * scrolls a stale frame into view). */
      stop(): void
      start(): void
      raf2(): Promise<void>
    }
  }
}
