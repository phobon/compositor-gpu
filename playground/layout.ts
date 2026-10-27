/// <reference path="./layout.d.ts" />
// typegpu reads process.env at evaluation: the shim must run first.
import '@/util/env'
import './nav'
import { createEffects, layoutMorph, shockwave } from '@/fx'
import { createCompositor } from '@/index'

// Layout morph playground (M5d-2): a grid of cards and a detail view of
// the first, swapped under fx `layoutMorph`. Cards, their images and
// titles and the heading are keyed (`data-gpu-morph`), so they move and
// resize between the two layouts; the rest cross-fades. Next plays one;
// `?auto` cycles; `?ms=` sets the duration; `?vr` is the harness view
// (window.__layout holds a morph at any progress). capture() and
// settled() times collect on window.__layout.results.

const q = new URLSearchParams(location.search)
const vr = q.has('vr')
const page = document.getElementById('page') as HTMLElement
const NAMES = ['Harbour', 'Quarry', 'Orchard']

// Icons keyed per card: vector svgs (data-gpu-morph draws them through the
// path pass), so their shapes morph: play -> pause (one shape into two),
// and a stroked check -> plus.
const ICONS = [
  [
    '<path d="M8 5 L19 12 L8 19 Z" />',
    '<rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" />'
  ],
  [
    '<path d="M5 12 L10 17 L19 7" fill="none" stroke="C" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />',
    '<path d="M12 5 L12 19 M5 12 L19 12" fill="none" stroke="C" stroke-width="2.5" stroke-linecap="round" />'
  ],
  [
    '<circle cx="12" cy="12" r="7" />',
    '<path d="M12 3 L14.6 9.4 L21.5 9.9 L16.2 14.3 L17.9 21 L12 17.3 L6.1 21 L7.8 14.3 L2.5 9.9 L9.4 9.4 Z" />'
  ]
]
const icon = (i: number, s: number, color: string): string =>
  `<svg class="icon" viewBox="0 0 24 24" data-gpu-morph="icon-${i}" fill="${color}">${(ICONS[i]?.[s] ?? '').replaceAll('"C"', `"${color}"`)}</svg>`

// A larger stroked mark: a hexagon in the grid, a triangle in the detail
// view (polygons morphing across vertex counts).
const MARKS = [
  'M50 6 L88 28 L88 72 L50 94 L12 72 L12 28 Z',
  'M50 10 L92 86 L8 86 Z'
]
const mark = (s: number): string =>
  `<svg class="mark" viewBox="0 0 100 100" data-gpu-morph="mark"><path d="${MARKS[s]}" fill="none" stroke="#c2410c" stroke-width="7" stroke-linejoin="round" /></svg>`

const card = (i: number, cls: string, s: number, extra = ''): string => `
  <article class="card ${cls}" data-gpu-morph="card-${i}">
    <img src="./test.png" alt="" data-gpu-morph="img-${i}" />
    <div class="row">
      <h2 data-gpu-morph="name-${i}">${NAMES[i]}</h2>
      ${icon(i, s, cls === 'hero' ? '#f4f1ea' : '#151517')}
    </div>${extra}
  </article>`

const STATES = [
  () => `
    <h1 data-gpu-morph="title">Projects</h1>
    <div class="grid">${[0, 1, 2].map((i) => card(i, '', 0)).join('')}</div>
    ${mark(0)}`,
  () => `
    <h1 data-gpu-morph="title">Project 01</h1>
    ${card(0, 'hero', 1, '<p>Stone, water and a long horizon: the first of three studies, opened from the grid. Its box, image and title move here; this text fades in.</p>')}
    <div class="side">${mark(1)}${[1, 2].map((i) => card(i, '', 1)).join('')}</div>`
]
let state = 0
const show = (s: number): void => {
  state = s
  page.className = s === 0 ? 'a' : 'b'
  page.innerHTML = STATES[s]?.() ?? ''
}
show(0)

const compositor = await createCompositor({ root: page, mode: 'replace' })
compositor.start()
await compositor.ready
const fx = createEffects(compositor)
const wave = shockwave(fx, { bulge: 0.08, zoom: 0.03 })
const m = layoutMorph(fx)
const waveBox = document.getElementById('wave') as HTMLInputElement
const ease = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2

const results: { captureMs: number; settleMs: number }[] = []
let busy = false
const next = async (): Promise<void> => {
  if (busy) {
    return
  }
  busy = true
  const t0 = performance.now()
  await m.capture()
  const t1 = performance.now()
  show(1 - state)
  await m.settled()
  results.push({ captureMs: t1 - t0, settleMs: performance.now() - t1 })
  if (waveBox.checked) {
    wave.play()
  }
  await m.play(Number(q.get('ms') ?? 800), ease)
  busy = false
}

document.getElementById('next')?.addEventListener('click', () => {
  void next()
})
if (q.has('auto') && !vr) {
  const loop = async (): Promise<void> => {
    await next()
    setTimeout(() => void loop(), 900)
  }
  void loop()
}

window.__layout = {
  morph: m,
  results,
  async hold(s, progress) {
    await m.capture()
    show(s)
    await m.settled()
    m.progress = progress
  },
  at(progress) {
    m.progress = progress
  },
  end() {
    m.end()
  }
}
Object.assign(window, { __gpu: compositor, __fx: fx })
