declare global {
  interface Window {
    /** The effect textures playground (test/fx/run.ts drives it). */
    __textures?: {
      /** Each texture's load result. */
      ready(): Promise<boolean[]>
      warp(on: boolean): void
      /** The ramp box, viewport CSS px. */
      rampRect(): number[]
    }
  }
}

export {}
