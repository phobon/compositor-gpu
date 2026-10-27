import type { Glow } from '@/fx'

declare global {
  interface Window {
    /** The distance field playground (test/fx/run.ts drives it). */
    __sdf?: {
      glows: Glow[]
      /** Resolves once every field has been built. */
      built(): Promise<void>
      /** Create (true) or destroy (false) the glows and their fields. */
      set(on: boolean): Promise<void>
    }
  }
}
