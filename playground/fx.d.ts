import type { Effects, Layer, Material, Pass } from '@/fx'
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
      /** progressiveBlur on #orbit. */
      progressive: Pass
      /** A quad drawn right after #after-anchor. */
      after: Layer
      /** Pin two clicks around the viewport centre (fx.__override). */
      pinClicks(): void
      mripple: Material
      wave: Material
      bend: Material
      tint: Material
      /** A per-letter stagger (mat_index) on #stg-heading. */
      stagger: Material
      /** A fullscreen pass sampling #mat-img (`image`). */
      pimage: Pass
      /** M3b: the heading's glyphs drawn by a Layer. */
      lglyphs: Layer
      /** An image Target sampled by a Layer. */
      limage: Layer
      /** A simulated Layer ('use gpu' simulate hook). */
      sim: Layer
      /** A raw box program. */
      raw: Material
      /** A 'use gpu' material fragment. */
      tgbox: Material
      /** A 'use gpu' pass fragment. */
      tgjs: Pass
      /** Pin two clicks on the element with this id. */
      pinClicksOn(id: string): void
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
