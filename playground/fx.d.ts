import type { Effects, Pass } from '@/fx'
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
