// Two reports side by side (docs/PROFILER.md, M6e): the headline numbers
// for the whole run and for each phase both have (by mark label), and
// the GPU per frame by pass label, with warnings when they ran on
// different adapters or viewports (their GPU and pacing numbers then
// don't compare). With several runs a side (`npm run profile --runs`),
// medians, and each run's value for the spread. Lower is better for
// every metric. Pure: no DOM.
// Shown by the devtools' and the report's Compare tab and printed by
// `npm run profile --baseline` (tools/profile/compare.ts).

import type { ProfileReport, ProfileSummary } from './profiler'

export interface CompareRow {
  /** 'run', a phase label, or 'gpu' for pass labels. */
  scope: string
  metric: string
  /** The median over each side's runs. */
  base: number | null
  now: number | null
  /** Each run's value, when a side has more than one run. */
  baseRuns?: number[]
  nowRuns?: number[]
}

export interface Comparison {
  warnings: string[]
  rows: CompareRow[]
}

type Metrics = [string, number | null][]

const metrics = (s: ProfileSummary): Metrics => [
  ['late frames', s.late],
  ['dropped frames', s.dropped],
  ['frame interval p95', s.dt.p95],
  ['compositor p50', s.cpu.total.p50],
  ['compositor p95', s.cpu.total.p95],
  ['read p95', s.cpu.read.p95],
  ['GPU p50', s.gpu?.total.p50 ?? null],
  ['GPU p95', s.gpu?.total.p95 ?? null]
]

const gpuMetrics = (r: ProfileReport): Metrics =>
  Object.entries(r.gpu?.passes ?? {}).map(([l, p]) => [`${l} p50`, p.p50])

/** The median of the numbers; null when there are none. */
export function median(xs: number[]): number | null {
  const v = [...xs].sort((a, b) => a - b)
  const m = v.length >> 1
  if (v.length === 0) {
    return null
  }
  return v.length % 2
    ? (v[m] as number)
    : ((v[m - 1] as number) + (v[m] as number)) / 2
}

/** Per metric, each report's value (the reports lacking it skipped). */
function collect(all: Metrics[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const ms of all) {
    for (const [k, v] of ms) {
      const list = out.get(k) ?? []
      out.set(k, list)
      if (v !== null && !Number.isNaN(v)) {
        list.push(v)
      }
    }
  }
  return out
}

function envWarnings(now: ProfileReport, base: ProfileReport): string[] {
  const warnings: string[] = []
  if ((now.env.adapter ?? '') !== (base.env.adapter ?? '')) {
    warnings.push(
      `adapters differ (${base.env.adapter ?? 'unknown'} → ${now.env.adapter ?? 'unknown'}): GPU and pacing numbers don't compare`
    )
  }
  if (
    now.env.width !== base.env.width ||
    now.env.height !== base.env.height ||
    now.env.dpr !== base.env.dpr
  ) {
    warnings.push(
      `viewports differ (${base.env.width}×${base.env.height}@${base.env.dpr} → ${now.env.width}×${now.env.height}@${now.env.dpr})`
    )
  }
  return warnings
}

/** Several runs of a scenario against several of a baseline: each
 * metric's median on both sides, with every run's value when a side has
 * more than one (one run of a page swings by tens of dropped frames). */
export function compareRuns(
  now: ProfileReport[],
  base: ProfileReport[]
): Comparison {
  const [n0, b0] = [now[0], base[0]]
  if (!n0 || !b0) {
    return { warnings: ['nothing to compare'], rows: [] }
  }
  const rows: CompareRow[] = []
  const add = (scope: string, a: Metrics[], b: Metrics[]): void => {
    const [an, bn] = [collect(a), collect(b)]
    for (const [metric, vs] of an) {
      const bs = bn.get(metric) ?? []
      rows.push({
        scope,
        metric,
        now: median(vs),
        base: median(bs),
        ...(now.length > 1 ? { nowRuns: vs } : {}),
        ...(base.length > 1 ? { baseRuns: bs } : {})
      })
    }
  }
  add('run', now.map(metrics), base.map(metrics))
  for (const p of n0.phases) {
    const of = (rs: ProfileReport[]): Metrics[] =>
      rs.flatMap((r) => {
        const q = r.phases.find((x) => x.label === p.label)
        return q ? [metrics(q.summary)] : []
      })
    const b = of(base)
    if (b.length > 0) {
      add(p.label, of(now), b)
    }
  }
  const gpu = (rs: ProfileReport[]): Metrics[] => rs.map(gpuMetrics)
  const labels = new Set([
    ...collect(gpu(now)).keys(),
    ...collect(gpu(base)).keys()
  ])
  const [gn, gb] = [collect(gpu(now)), collect(gpu(base))]
  for (const l of labels) {
    const vs = gn.get(l) ?? []
    const bs = gb.get(l) ?? []
    rows.push({
      scope: 'gpu',
      metric: l,
      now: median(vs),
      base: median(bs),
      ...(now.length > 1 ? { nowRuns: vs } : {}),
      ...(base.length > 1 ? { baseRuns: bs } : {})
    })
  }
  return { warnings: envWarnings(n0, b0), rows }
}

export function compareReports(
  now: ProfileReport,
  base: ProfileReport
): Comparison {
  return compareRuns([now], [base])
}

/** The change, signed; null when either side is missing. */
export function delta(r: CompareRow): number | null {
  return r.now === null || r.base === null ? null : r.now - r.base
}

/** Whether the change is inside the runs' spread: with several runs on
 * both sides, their ranges overlap. */
export function withinSpread(r: CompareRow): boolean {
  if (!r.nowRuns?.length || !r.baseRuns?.length) {
    return false
  }
  return (
    Math.min(...r.nowRuns) <= Math.max(...r.baseRuns) &&
    Math.min(...r.baseRuns) <= Math.max(...r.nowRuns)
  )
}

const fmt = (v: number | null): string =>
  v === null || Number.isNaN(v) ? 'n/a' : v.toFixed(2)

const range = (xs?: number[]): string =>
  xs && xs.length > 1
    ? `${fmt(Math.min(...xs)).replace(/\.00$/, '')}–${fmt(Math.max(...xs)).replace(/\.00$/, '')}`
    : ''

/** As text lines (the CLI). */
export function compareLines(c: Comparison): string[] {
  return [
    ...c.warnings,
    ...c.rows.map((r) => {
      const d = delta(r)
      const change = d === null ? '' : `${d > 0 ? '+' : ''}${fmt(d)}`
      const spread =
        r.nowRuns || r.baseRuns
          ? `  [${range(r.baseRuns) || fmt(r.base)} → ${range(r.nowRuns) || fmt(r.now)}${withinSpread(r) ? ', within spread' : ''}]`
          : ''
      return `${`${r.scope === 'run' ? '' : `${r.scope}: `}${r.metric}`.padEnd(30)} ${fmt(r.base).padStart(8)} → ${fmt(r.now).padStart(8)}  ${change.padEnd(7)}${spread}`.trimEnd()
    })
  ]
}
