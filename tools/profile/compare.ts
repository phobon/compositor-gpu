// A recording against a baseline for `npm run profile --baseline`
// (tools/profile.ts; docs/PROFILER.md, M6d): the headline numbers side
// by side, and a warning when the two ran on different adapters or
// viewports (their GPU and pacing numbers then don't compare). Pure.

import type { ProfileReport } from '../../src/profile/profiler'

const f = (v: number | undefined): string =>
  v === undefined || Number.isNaN(v) ? 'n/a' : v.toFixed(2)

export function compareReports(
  now: ProfileReport,
  base: ProfileReport
): string[] {
  const out: string[] = []
  if ((now.env.adapter ?? '') !== (base.env.adapter ?? '')) {
    out.push(
      `adapters differ (${base.env.adapter ?? 'unknown'} → ${now.env.adapter ?? 'unknown'}): GPU and pacing numbers don't compare`
    )
  }
  if (
    now.env.width !== base.env.width ||
    now.env.height !== base.env.height ||
    now.env.dpr !== base.env.dpr
  ) {
    out.push(
      `viewports differ (${base.env.width}×${base.env.height}@${base.env.dpr} → ${now.env.width}×${now.env.height}@${now.env.dpr})`
    )
  }
  const row = (
    label: string,
    a: number | undefined,
    b: number | undefined
  ): void => {
    const d = a !== undefined && b !== undefined ? a - b : Number.NaN
    const sign = d > 0 ? '+' : ''
    out.push(
      `${label.padEnd(22)} ${f(b).padStart(8)} → ${f(a).padStart(8)}  ${Number.isNaN(d) ? '' : `${sign}${f(d)}`}`
    )
  }
  row('late frames', now.late, base.late)
  row('dropped frames', now.dropped, base.dropped)
  row('frame interval p95', now.dt.p95, base.dt.p95)
  row('compositor p50', now.cpu.total.p50, base.cpu.total.p50)
  row('compositor p95', now.cpu.total.p95, base.cpu.total.p95)
  row('read p95', now.cpu.read.p95, base.cpu.read.p95)
  row('GPU p50', now.gpu?.total.p50, base.gpu?.total.p50)
  row('GPU p95', now.gpu?.total.p95, base.gpu?.total.p95)
  return out
}
