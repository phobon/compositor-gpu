// The Elements view (docs/PROFILER.md, M6b): over a recording, which
// elements cost the compositor most (frames that re-read them, a share
// of the read time, the invalidations aimed at them), the GPU passes by
// total time, and what kept the frame loop running.

import { chip, type FrameActions } from './frame_view'
import { fmtMs, h, type Model } from './model'

const ROWS = 40

function table(head: string[], rows: (Node | string)[][]): HTMLElement {
  return h(
    'table',
    {},
    h('thead', {}, h('tr', {}, ...head.map((t) => h('th', { text: t })))),
    h(
      'tbody',
      {},
      ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, c))))
    )
  )
}

export function renderElements(
  root: HTMLElement,
  m: Model,
  act: FrameActions
): void {
  root.replaceChildren()
  const els = m.elementCosts()
  if (els.length === 0) {
    root.append(
      h('p', {
        class: 'empty',
        text: 'No element was re-read or invalidated in this recording.'
      })
    )
  } else {
    root.append(
      h('h3', { text: 'Elements' }),
      h('p', {
        class: 'dim',
        text: 'Read time is each frame’s DOM read split evenly over the elements it re-read.'
      }),
      table(
        ['element', 'read time', 're-read in', 'invalidations'],
        els.slice(0, ROWS).map((c) => [
          chip(m, c.el, act),
          fmtMs(c.readMs, 2),
          `${c.reads} frame${c.reads === 1 ? '' : 's'}`,
          Object.entries(c.kinds)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([k, n]) => `${k} ×${n}`)
            .join(', ') || '—'
        ])
      )
    )
    if (els.length > ROWS) {
      root.append(h('p', { class: 'dim', text: `+${els.length - ROWS} more` }))
    }
  }
  const gpu = m.gpuCosts()
  if (gpu.length > 0) {
    root.append(
      h('h3', { text: 'GPU passes' }),
      table(
        ['label', 'total', 'per frame', 'worst', 'frames'],
        gpu.map((c) => [
          c.label,
          fmtMs(c.totalMs),
          fmtMs(c.totalMs / Math.max(1, c.frames), 2),
          fmtMs(c.maxMs, 2),
          String(c.frames)
        ])
      )
    )
  }
  const fx = m.effectCosts()
  if (fx.length > 0) {
    root.append(
      h('h3', { text: 'Effects' }),
      h('p', {
        class: 'dim',
        text: 'Frames each effect kept the loop running, and its own GPU passes (fx:<name>; layers and materials draw inside the shared passes).'
      }),
      table(
        ['effect', 'kept running', 'GPU total', 'GPU per frame'],
        fx.map((e) => [
          `${e.kind} ${e.name}`,
          `${e.frames} frame${e.frames === 1 ? '' : 's'}`,
          e.gpuMs > 0 ? fmtMs(e.gpuMs) : '—',
          e.gpuFrames > 0 ? fmtMs(e.gpuMs / e.gpuFrames, 2) : '—'
        ])
      )
    )
  }
  const alive = m.aliveCosts()
  if (alive.length > 0) {
    root.append(
      h('h3', { text: 'Kept the loop running' }),
      table(
        ['what', 'frames'],
        alive.map(([k, n]) => [k, String(n)])
      )
    )
  }
}
