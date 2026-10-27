declare global {
  interface Window {
    /** The vector images playground (test/fx/run.ts drives it). */
    __vectors?: {
      /** Path shapes each img of the first two img rows draws (0: drawn
       * as an image). */
      shapes(): number[]
      /** Swap the morphing img to the next icon and hold the morph at
       * `progress`. */
      hold(progress: number): Promise<void>
      end(): void
    }
  }
}

export {}
