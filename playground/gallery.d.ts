import type { Layer } from '@/fx'

declare global {
  interface Window {
    /** The gallery playground (test/fx/run.ts drives it). */
    __gallery?: {
      layer: Layer
      /** Open or close at once, without the transitions. */
      show(on: boolean): void
    }
  }
}
