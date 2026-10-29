// Several runs of one scenario (`npm run profile --runs N`;
// docs/PROFILER.md): which run stands for them (the report, the budget
// and recording.cgprof use it), and a line per run. Pure: no browser.

import { median } from '../../src/profile/compare'
import type { ProfileReport } from '../../src/profile/profiler'

/** The run whose dropped frames are nearest the median's (the first
 * such). */
export function medianRun(reports: ProfileReport[]): number {
  const m = median(reports.map((r) => r.dropped)) ?? 0
  let best = 0
  reports.forEach((r, i) => {
    const b = reports[best] as ProfileReport
    if (Math.abs(r.dropped - m) < Math.abs(b.dropped - m)) {
      best = i
    }
  })
  return best
}

/** `run 2: dropped 67 (scroll 20, fling 27), late 60, GPU p50 4.93 ms` */
export function runLine(r: ProfileReport, i: number): string {
  const phases = r.phases
    .filter((p) => p.summary.dropped > 0)
    .map((p) => `${p.label} ${p.summary.dropped}`)
    .join(', ')
  const gpu = r.gpu ? `, GPU p50 ${r.gpu.total.p50.toFixed(2)} ms` : ''
  return `run ${i + 1}: dropped ${r.dropped}${phases ? ` (${phases})` : ''}, late ${r.late}${gpu}`
}
