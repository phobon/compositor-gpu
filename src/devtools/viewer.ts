// The standalone recording viewer (docs/PROFILER.md, M6d): the devtools'
// Timeline (with the selected frame under it) and Elements views over a
// recording, with no compositor, for the CLI's HTML report
// (tools/profile.ts) and any page that wants to show a `.cgprof` file.
// A header carries where and how it was recorded, the headline numbers
// and, when given, the budget's verdict. Elements aren't live here: chips
// show paths only.
//
//   mountViewer(document.body, recording, { budget })

import { missed } from '../profile/profiler'
import type { Recording } from '../profile/recording'
import { CSS } from './css'
import { renderElements } from './elements_view'
import { type FrameActions, renderFrame } from './frame_view'
import { fmtMs, h, Model } from './model'
import { Timeline } from './timeline'

/** A budget row (tools/profile/budget.ts). */
export interface BudgetRow {
  scope: string
  name: string
  value: number
  limit: number
  ok: boolean
}

export interface ViewerOptions {
  budget?: BudgetRow[]
  /** Lines comparing against a baseline (tools/profile/compare.ts). */
  baseline?: string[]
}

const VIEWER_CSS = `
.root { position: relative; min-height: 100vh; background: #111114; }
header { padding: 14px 16px 6px; border-bottom: 1px solid var(--line); }
header h1 { font-size: 15px; margin: 0 0 4px; }
.env { color: var(--dim); font-size: 11px; display: flex; gap: 14px; flex-wrap: wrap; }
.verdict.ok { color: #34d399; } .verdict.fail { color: var(--bad); }
.budget td.fail { color: var(--bad); }
.vbody { padding: 8px 16px 24px; }
pre { white-space: pre-wrap; color: var(--dim); font-size: 11px; }
`

/** Show `r` in `parent` (in a shadow root, as the devtools). */
export function mountViewer(
  parent: HTMLElement,
  r: Recording,
  opts: ViewerOptions = {}
): { destroy(): void } {
  const host = document.createElement('div')
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CSS + VIEWER_CSS
  const root = h('div', { class: 'root' })
  shadow.append(style, root)
  parent.append(host)

  const m = new Model(r)
  const rep = r.report
  const late = rep.samples.filter((s) => missed(s, m.refresh) > 0).length
  const card = (k: string, v: string, bad = false): HTMLElement =>
    h(
      'div',
      { class: `card${bad ? ' bad' : ''}` },
      h('div', { class: 'v', text: v }),
      h('div', { class: 'k', text: k })
    )
  const p95 = (v: number | undefined): string =>
    v === undefined ? 'n/a' : fmtMs(v)
  const failed = (opts.budget ?? []).filter((b) => !b.ok)
  const header = h(
    'header',
    {},
    h('h1', {
      text:
        r.title ??
        `${r.kind === 'flight' ? 'Flight recording' : 'Recording'} ${new Date(r.savedAt).toLocaleString()}`
    }),
    h(
      'div',
      { class: 'env' },
      h('span', { text: rep.env.url ?? '' }),
      h('span', {
        text: `${rep.env.width}×${rep.env.height} @${rep.env.dpr}x`
      }),
      h('span', { text: rep.env.adapter ?? '' }),
      h('span', { text: rep.env.mode ? `mode ${rep.env.mode}` : '' }),
      h('span', { text: rep.env.userAgent })
    ),
    h(
      'div',
      { class: 'cards' },
      card(
        'frames',
        `${rep.frames} over ${(rep.durationMs / 1000).toFixed(1)} s`
      ),
      card('refresh', `${(1000 / m.refresh).toFixed(0)} Hz`),
      card('late / dropped', `${late} / ${rep.dropped}`, late > 0),
      card('compositor p95', p95(rep.cpu.total?.p95)),
      card('GPU p95', p95(rep.gpu?.total.p95)),
      card('DOM reads', `${rep.reads.partial} partial, ${rep.reads.full} full`)
    )
  )
  if (opts.budget?.length) {
    const t = h(
      'table',
      { class: 'budget' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ...['scope', 'budget', 'measured', 'limit'].map((x) =>
            h('th', { text: x })
          )
        )
      ),
      h(
        'tbody',
        {},
        ...opts.budget.map((b) =>
          h(
            'tr',
            {},
            h('td', { text: b.scope }),
            h('td', { text: b.name }),
            h('td', {
              class: b.ok ? '' : 'fail',
              text: String(Number(b.value.toFixed(2)))
            }),
            h('td', { text: String(b.limit) })
          )
        )
      )
    )
    header.append(
      h('h3', {
        class: `verdict ${failed.length ? 'fail' : 'ok'}`,
        text: failed.length
          ? `Over budget: ${failed.map((b) => `${b.scope} ${b.name}`).join(', ')}`
          : 'Within budget'
      }),
      t
    )
  }
  if (opts.baseline?.length) {
    header.append(
      h('h3', { text: 'Against the baseline' }),
      h('pre', { text: opts.baseline.join('\n') })
    )
  }

  // Tabs.
  const tabs = h('div', { class: 'tabs', role: 'tablist' })
  const status = h('div', { class: 'status' })
  const bar = h('div', { class: 'bar' }, tabs, h('span', { class: 'spacer' }))
  const timelineView = h('div', { class: 'view' })
  const elementsView = h('div', { class: 'view' })
  const timelineBox = h('div')
  const frameBox = h('div')
  timelineView.append(timelineBox, frameBox)
  const body = h('div', { class: 'vbody' }, timelineView, elementsView)
  root.append(header, bar, status, body)

  let selected = -1
  const actions: FrameActions = {
    select: (i) => select(i),
    outline: () => {},
    reveal: () => {}
  }
  const hint = `${m.samples.length} frames, ${m.late.length} late. Wheel zooms, drag pans, click a frame; ← → frames, [ ] late frames.`
  const timeline = new Timeline(timelineBox, {
    onSelect: (i) => select(i),
    onHover: (t) => {
      status.textContent = t ?? hint
    }
  })
  const select = (i: number): void => {
    selected = Math.max(0, Math.min(i, m.samples.length - 1))
    timeline.select(selected)
    renderFrame(frameBox, m, selected, actions)
  }
  const show = (which: 'timeline' | 'elements'): void => {
    timelineView.hidden = which !== 'timeline'
    elementsView.hidden = which !== 'elements'
    for (const b of tabs.children) {
      b.setAttribute(
        'aria-selected',
        String(b.getAttribute('data-tab') === which)
      )
    }
  }
  for (const [id, label] of [
    ['timeline', 'Timeline'],
    ['elements', 'Elements']
  ] as const) {
    const b = h('button', {
      class: 'tab',
      type: 'button',
      role: 'tab',
      'data-tab': id,
      text: label
    })
    b.addEventListener('click', () => show(id))
    tabs.append(b)
  }
  timeline.setModel(m)
  renderElements(elementsView, m, actions)
  let worst = m.samples.length - 1
  let worstDt = 0
  for (const i of m.late) {
    const d = m.hitch(i).dt
    if (d > worstDt) {
      worstDt = d
      worst = i
    }
  }
  select(worst)
  show('timeline')
  status.textContent = hint

  const onKey = (e: KeyboardEvent): void => {
    if (timelineView.hidden) {
      return
    }
    if (e.key === 'ArrowLeft') {
      select(selected - 1)
    } else if (e.key === 'ArrowRight') {
      select(selected + 1)
    } else if (e.key === '[') {
      const k = [...m.late].reverse().find((x) => x < selected)
      if (k !== undefined) {
        select(k)
      }
    } else if (e.key === ']') {
      const k = m.late.find((x) => x > selected)
      if (k !== undefined) {
        select(k)
      }
    } else if (e.key === 'f') {
      timeline.fit()
    } else {
      return
    }
    e.preventDefault()
  }
  document.addEventListener('keydown', onKey)
  return {
    destroy() {
      document.removeEventListener('keydown', onKey)
      timeline.destroy()
      host.remove()
    }
  }
}
