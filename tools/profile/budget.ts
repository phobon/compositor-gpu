// Budgets for `npm run profile` (tools/profile.ts; docs/PROFILER.md,
// M6d): limits on a recording's numbers, for the whole run and per phase
// (a scenario's marks). Pure: no DOM, no browser.
//
//   {
//     "droppedCompositor": 0,   dropped frames whose largest factor is
//                               the compositor or the GPU
//     "dropped": 4,             all dropped frames
//     "late": 2,                late frames
//     "frameP95": 9,            frame interval p95, ms (paced frames)
//     "cpuP95": 2,              compositor CPU per frame p95, ms
//     "readP95": 1,             its DOM read p95, ms
//     "gpuP95": 7.5,            GPU per frame p95, ms (timestamp-query)
//     "phases": { "scroll": { "droppedCompositor": 0 } }
//   }

import {
  hitchAt,
  missed,
  type ProfileReport,
  type ProfileSummary
} from '../../src/profile/profiler'

export interface Limits {
  droppedCompositor?: number
  dropped?: number
  late?: number
  frameP95?: number
  cpuP95?: number
  readP95?: number
  gpuP95?: number
}

export interface Budget extends Limits {
  phases?: Record<string, Limits>
}

export interface BudgetRow {
  /** 'run' or the phase's label. */
  scope: string
  name: keyof Limits
  value: number
  limit: number
  ok: boolean
}

const KEYS: (keyof Limits)[] = [
  'droppedCompositor',
  'dropped',
  'late',
  'frameP95',
  'cpuP95',
  'readP95',
  'gpuP95'
]

/** Frames dropped in [from, to) (ms after the report's origin) whose
 * largest factor is the compositor or the GPU, over every late frame
 * (the summary keeps only the worst twelve hitches). */
export function droppedCompositor(
  r: ProfileReport,
  from = -Infinity,
  to = Infinity
): number {
  const origin = r.origin ?? 0
  let n = 0
  r.samples.forEach((s, i) => {
    const at = s.t - origin
    if (at < from || at >= to || missed(s, r.refreshMs) === 0) {
      return
    }
    const h = hitchAt(r.samples, i, r.refreshMs, origin, r.longFrames)
    if (h.cause === 'compositor cpu' || h.cause === 'gpu') {
      n += h.missed
    }
  })
  return n
}

/** The number a limit applies to; null when the run can't say (no GPU
 * timings). `dc`: droppedCompositor for the same frames. */
export function measure(
  s: ProfileSummary,
  k: keyof Limits,
  dc: () => number
): number | null {
  switch (k) {
    case 'droppedCompositor':
      return dc()
    case 'dropped':
      return s.dropped
    case 'late':
      return s.late
    case 'frameP95':
      return s.dt.p95
    case 'cpuP95':
      return s.cpu.total.p95
    case 'readP95':
      return s.cpu.read.p95
    case 'gpuP95':
      return s.gpu ? s.gpu.total.p95 : null
  }
}

function rows(
  scope: string,
  s: ProfileSummary,
  l: Limits,
  dc: () => number
): BudgetRow[] {
  const out: BudgetRow[] = []
  for (const k of KEYS) {
    const limit = l[k]
    if (limit === undefined) {
      continue
    }
    const value = measure(s, k, dc)
    if (value === null) {
      continue
    }
    out.push({ scope, name: k, value, limit, ok: value <= limit })
  }
  return out
}

/** Every limit of `b` against `r`: the run, then each phase it names
 * (a phase the run doesn't have fails, as a missing measurement). */
export function checkBudget(r: ProfileReport, b: Budget): BudgetRow[] {
  const out = rows('run', r, b, () => droppedCompositor(r))
  for (const [label, l] of Object.entries(b.phases ?? {})) {
    const k = r.marks.findIndex((x) => x.label === label)
    const p = r.phases.find((x) => x.label === label)
    if (!p) {
      out.push({
        scope: label,
        name: 'late',
        value: Number.NaN,
        limit: 0,
        ok: false
      })
      continue
    }
    const from = r.marks[k]?.at ?? 0
    const to = r.marks[k + 1]?.at ?? Infinity
    out.push(...rows(label, p.summary, l, () => droppedCompositor(r, from, to)))
  }
  return out
}

/** The rows as a table for the terminal. */
export function formatBudget(rs: readonly BudgetRow[]): string {
  const f = (v: number): string =>
    Number.isNaN(v) ? 'no phase' : String(Number(v.toFixed(2)))
  return rs
    .map(
      (r) =>
        `  ${r.ok ? 'ok  ' : 'OVER'} ${`${r.scope} ${r.name}`.padEnd(32)} ${f(r.value).padStart(8)}  ≤ ${r.limit}`
    )
    .join('\n')
}
