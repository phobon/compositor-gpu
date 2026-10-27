declare global {
  interface Window {
    /** The distance mask playground (test/fx/run.ts drives it). */
    __masks?: {
      /** Waits for both star fields; each one's ready. */
      ready(): Promise<boolean[]>
      /** The live and baked stars, viewport CSS px. */
      rects(): number[][]
    }
  }
}

export {}
