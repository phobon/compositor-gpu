import type { Trail } from '@/fx'

declare global {
  interface Window {
    /** The trail playground's field (test/fx/run.ts drives it). */
    __trail?: Trail
  }
}
