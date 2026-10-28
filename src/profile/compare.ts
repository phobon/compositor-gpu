// Two reports side by side (docs/PROFILER.md, M6e): the headline numbers
// for the whole run and for each phase both have (by mark label), and
// the GPU per frame by pass label, with warnings when they ran on
// different adapters or viewports (their GPU and pacing numbers then
// don't compare). Lower is better for every metric. Pure: no DOM.
// Shown by the devtools' and the report's Compare tab and printed by
// `npm run profile --baseline` (tools/profile/compare.ts).

import type { ProfileReport, ProfileSummary } from './profiler'

export interface CompareRow {
  /** 'run', a phase label, or 'gpu' for pass labels. */
  scope: string
  metric: string
  base: number | null
  now: number | null
}

export interface Comparison {
  warnings: string[]
  rows: CompareRow[]
}

const metrics = (s: ProfileSummary): [string, number | null][] => [
  ['late frames', s.late],
  ['dropped frames', s.dropped],
  ['frame interval p95', s.dt.p95],
  ['compositor p50', s.cpu.total.p50],
  ['compositor p95', s.cpu.total.p95],
  ['read p95', s.cpu.read.p95],
  ['GPU p50', s.gpu?.total.p50 ?? null],
  ['GPU p95', s.gpu?.total.p95 ?? null]
]

export function compareReports(
  now: ProfileReport,
  base: ProfileReport
): Comparison {
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
  const rows: CompareRow[] = []
  const add = (scope: string, a: ProfileSummary, b: ProfileSummary): void => {
    const bm = new Map(metrics(b))
    for (const [metric, v] of metrics(a)) {
      rows.push({ scope, metric, now: v, base: bm.get(metric) ?? null })
    }
  }
  add('run', now, base)
  for (const p of now.phases) {
    const q = base.phases.find((x) => x.label === p.label)
    if (q) {
      add(p.label, p.summary, q.summary)
    }
  }
  const labels = new Set([
    ...Object.keys(now.gpu?.passes ?? {}),
    ...Object.keys(base.gpu?.passes ?? {})
  ])
  for (const l of labels) {
    rows.push({
      scope: 'gpu',
      metric: `${l} p50`,
      now: now.gpu?.passes[l]?.p50 ?? null,
      base: base.gpu?.passes[l]?.p50 ?? null
    })
  }
  return { warnings, rows }
}

/** The change, signed; null when either side is missing. */
export function delta(r: CompareRow): number | null {
  return r.now === null || r.base === null ? null : r.now - r.base
}

/** As text lines (the CLI). */
export function compareLines(c: Comparison): string[] {
  const f = (v: number | null): string =>
    v === null || Number.isNaN(v) ? 'n/a' : v.toFixed(2)
  return [
    ...c.warnings,
    ...c.rows.map((r) => {
      const d = delta(r)
      return `${`${r.scope === 'run' ? '' : `${r.scope}: `}${r.metric}`.padEnd(30)} ${f(r.base).padStart(8)} → ${f(r.now).padStart(8)}  ${d === null ? '' : `${d > 0 ? '+' : ''}${f(d)}`}`
    })
  ]
}
