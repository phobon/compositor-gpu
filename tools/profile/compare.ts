// A recording against a baseline for `npm run profile --baseline`
// (tools/profile.ts; docs/PROFILER.md, M6d): src/profile/compare.ts's
// comparison as lines for the terminal and summary.txt.

import {
  compareReports as compare,
  compareLines,
  compareRuns as runs
} from '../../src/profile/compare'
import type { ProfileReport } from '../../src/profile/profiler'

export function compareReports(
  now: ProfileReport,
  base: ProfileReport
): string[] {
  return compareLines(compare(now, base))
}

export function compareRuns(
  now: ProfileReport[],
  base: ProfileReport[]
): string[] {
  return compareLines(runs(now, base))
}
