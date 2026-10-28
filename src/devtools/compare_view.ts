// The Compare view (docs/PROFILER.md, M6e): a recording against a
// baseline (src/profile/compare.ts): the headline numbers for the run,
// each phase both have and each GPU pass label, base → now and the
// change, green when it went down, red when up.

import { type CompareRow, compareReports, delta } from '../profile/compare'
import type { ProfileReport } from '../profile/profiler'
import { h } from './model'

const f = (v: number | null): string =>
  v === null || Number.isNaN(v) ? 'n/a' : String(Number(v.toFixed(2)))

export function renderCompare(
  root: HTMLElement,
  now: ProfileReport,
  base: ProfileReport | null,
  baseLabel: string
): void {
  root.replaceChildren()
  if (!base) {
    root.append(
      h('p', {
        class: 'empty',
        text: 'Pick a baseline: another recording to compare this one with.'
      })
    )
    return
  }
  const c = compareReports(now, base)
  for (const w of c.warnings) {
    root.append(h('p', { class: 'note', text: w }))
  }
  const row = (r: CompareRow): HTMLElement => {
    const d = delta(r)
    const eps = Math.max(0.05, Math.abs(r.base ?? 0) * 0.02)
    const cls =
      d === null || Math.abs(d) < eps ? 'dim' : d < 0 ? 'better' : 'worse'
    return h(
      'tr',
      {},
      h('td', { text: r.scope === 'run' ? 'whole run' : r.scope }),
      h('td', { text: r.metric }),
      h('td', { text: f(r.base) }),
      h('td', { text: f(r.now) }),
      h('td', {
        class: cls,
        text: d === null ? '' : `${d > 0 ? '+' : ''}${f(d)}`
      })
    )
  }
  root.append(
    h('h3', { text: `Against ${baseLabel}` }),
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ...['scope', 'metric', 'baseline', 'this', 'change'].map((t) =>
            h('th', { text: t })
          )
        )
      ),
      h('tbody', {}, ...c.rows.map(row))
    )
  )
}
