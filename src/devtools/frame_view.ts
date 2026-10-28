// The Frame view (docs/PROFILER.md, M6b): one frame of a recording. A
// late frame first says why (its hitch factors, largest first, with the
// elements and script sources they name), then what the frame did: the
// compositor's phases, its DOM read and what triggered it, uploads,
// draws, GPU passes and what kept the loop running. Element chips outline
// the element on the page on hover and scroll to it on click (live
// recordings only).

import type { Factor } from '../profile/explain'
import { missed } from '../profile/profiler'
import {
  COLORS,
  FACTOR_COLORS,
  fmtAt,
  fmtMs,
  h,
  type Model,
  PHASES
} from './model'

export interface FrameActions {
  select(i: number): void
  /** Outline element `el` on the page (null: clear). */
  outline(el: number | null): void
  /** Scroll element `el` into view and flash it. */
  reveal(el: number): void
}

export function chip(m: Model, el: number, act: FrameActions): HTMLElement {
  const live = m.resolve(el) !== null
  const b = h('button', {
    class: `chip${live ? '' : ' dead'}`,
    type: 'button',
    title: live
      ? 'Hover to outline, click to scroll to it'
      : 'Not on this page',
    text: m.path(el)
  })
  if (live) {
    b.addEventListener('pointerenter', () => act.outline(el))
    b.addEventListener('pointerleave', () => act.outline(null))
    b.addEventListener('focus', () => act.outline(el))
    b.addEventListener('blur', () => act.outline(null))
    b.addEventListener('click', () => act.reveal(el))
  }
  return b
}

function factorRow(
  m: Model,
  f: Factor,
  max: number,
  act: FrameActions
): HTMLElement {
  const bar = h('span', { class: 'fbar' })
  bar.style.width = `${Math.max(2, (f.ms / Math.max(max, 1e-6)) * 100)}%`
  bar.style.background = FACTOR_COLORS[f.kind] ?? COLORS.other
  const row = h(
    'div',
    { class: 'factor' },
    h(
      'div',
      { class: 'fhead' },
      h('span', { class: `kind k-${f.kind}`, text: f.kind }),
      h('span', { class: 'fms', text: fmtMs(f.ms) }),
      h('span', { class: 'ftrack' }, bar)
    ),
    h('div', { class: 'ftext', text: f.text })
  )
  if (f.source) {
    row.append(h('div', { class: 'src', text: f.source, title: f.source }))
  }
  if (f.els?.length) {
    const chips = h('div', { class: 'chips' })
    for (const el of f.els.slice(0, 8)) {
      chips.append(chip(m, el, act))
    }
    row.append(chips)
  }
  return row
}

const section = (title: string, ...body: (Node | string)[]): HTMLElement =>
  h('section', {}, h('h3', { text: title }), ...body)

const kv = (k: string, v: Node | string): HTMLElement =>
  h(
    'div',
    { class: 'kv' },
    h('span', { class: 'k', text: k }),
    h('span', { class: 'v' }, v)
  )

/** Render frame `i` of `m` into `root` (replacing its contents). */
export function renderFrame(
  root: HTMLElement,
  m: Model,
  i: number,
  act: FrameActions
): void {
  root.replaceChildren()
  const s = m.samples[i]
  if (!s) {
    root.append(
      h('p', {
        class: 'empty',
        text: 'Select a frame on the Timeline (late frames are red).'
      })
    )
    return
  }
  const isLate = missed(s, m.refresh) > 0
  const nav = (
    label: string,
    title: string,
    to: number | undefined
  ): HTMLElement => {
    const b = h('button', { type: 'button', class: 'nav', title, text: label })
    if (to === undefined || to < 0 || to >= m.samples.length) {
      b.setAttribute('disabled', '')
    } else {
      b.addEventListener('click', () => act.select(to))
    }
    return b
  }
  const prevLate = [...m.late].reverse().find((k) => k < i)
  const nextLate = m.late.find((k) => k > i)
  root.append(
    h(
      'div',
      { class: 'framehead' },
      h('strong', { text: `Frame ${s.id}` }),
      h('span', {
        class: 'dim',
        text: `${fmtAt(m.at(i))} · ${fmtMs(s.dt)} since the last`
      }),
      h(
        'span',
        { class: 'navs' },
        nav('⇤ late', 'Previous late frame ([)', prevLate),
        nav('←', 'Previous frame (←)', i - 1),
        nav('→', 'Next frame (→)', i + 1),
        nav('late ⇥', 'Next late frame (])', nextLate)
      )
    )
  )

  if (isLate) {
    const hit = m.hitch(i)
    const fs = hit.factors ?? []
    const max = fs[0]?.ms ?? 1
    const list = h('div', { class: 'factors' })
    for (const f of fs) {
      list.append(factorRow(m, f, max, act))
    }
    root.append(
      section(
        `Late: ${hit.missed} frame${hit.missed === 1 ? '' : 's'} missed, ${fmtMs(hit.dt)} gap (refresh ${fmtMs(m.refresh)})`,
        list
      )
    )
  }

  // What the frame did.
  const phases = h('div', { class: 'phases' })
  for (const k of PHASES) {
    const v = s.cpu[k]
    if (v <= 0) {
      continue
    }
    const seg = h('span', { title: `${k} ${fmtMs(v, 2)}` })
    seg.style.flexGrow = String(v)
    seg.style.background = COLORS[k]
    phases.append(seg)
  }
  const legend = PHASES.filter((k) => s.cpu[k] >= 0.01)
    .map((k) => `${k} ${fmtMs(s.cpu[k], 2)}`)
    .join(' · ')
  const did = h('div', { class: 'did' })
  did.append(
    kv(
      'compositor',
      h(
        'span',
        {},
        phases,
        h('span', { class: 'dim', text: `${fmtMs(s.cpu.total, 2)}: ${legend}` })
      )
    )
  )
  did.append(
    kv(
      'DOM read',
      s.read === 'none'
        ? 'none'
        : `${s.read}, ${s.readElements} elements${s.cause ? ` (${s.cause})` : ''}`
    )
  )
  const why = s.why
  if (why && why.scopeCount > 0) {
    const chips = h('span', { class: 'chips' })
    for (const el of why.scopes) {
      chips.append(chip(m, el, act))
    }
    if (why.scopeCount > why.scopes.length) {
      chips.append(
        h('span', {
          class: 'dim',
          text: ` +${why.scopeCount - why.scopes.length}`
        })
      )
    }
    did.append(kv('re-read', chips))
  }
  if (why && (why.events.length > 0 || why.more > 0)) {
    const list = h('div', { class: 'events' })
    for (const e of why.events) {
      const row = h(
        'div',
        { class: 'event' },
        h('span', {
          class: 'ek',
          text: `${e.kind}${e.detail ? `[${e.detail}]` : ''}${e.n ? ` ×${e.n}` : ''}`
        })
      )
      if (e.el !== undefined) {
        row.append(chip(m, e.el, act))
      }
      list.append(row)
    }
    if (why.more > 0) {
      list.append(h('div', { class: 'dim', text: `+${why.more} more` }))
    }
    did.append(kv('triggered by', list))
  }
  const ups = Object.entries(s.uploads).filter(([, v]) => (v ?? 0) > 0)
  if (ups.length > 0) {
    did.append(
      kv('uploads', ups.map(([k, v]) => `${k} ${fmtMs(v ?? 0, 2)}`).join(', '))
    )
  }
  did.append(
    kv(
      'drawing',
      `${s.draws} draws, ${s.batches} batches, ${s.groups} groups${s.reused ? ', scene reused' : ''}${s.skipped ? ', nothing drawn (unchanged)' : ''}`
    )
  )
  if (s.gpu) {
    const spans = [...s.gpu.spans].sort((a, b) => b.ms - a.ms).slice(0, 8)
    did.append(
      kv(
        'GPU',
        `${fmtMs(s.gpu.totalMs, 2)}: ${spans.map((p) => `${p.label} ${fmtMs(p.ms, 2)}`).join(', ')}${s.gpu.untimed ? ` (+${s.gpu.untimed} untimed)` : ''}`
      )
    )
  }
  if (why?.alive.length) {
    did.append(kv('kept running by', why.alive.join(', ')))
  }
  root.append(section('What this frame did', did))
}
