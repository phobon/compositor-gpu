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

const card = (i: number, cls: string, extra = ''): string => `
  <article class="card ${cls}" data-gpu-morph="card-${i}">
    <img src="./test.png" alt="" data-gpu-morph="img-${i}" />
    <h2 data-gpu-morph="name-${i}">${NAMES[i]}</h2>${extra}
  </article>`

const STATES = [
  () => `
    <h1 data-gpu-morph="title">Projects</h1>
    <div class="grid">${[0, 1, 2].map((i) => card(i, '')).join('')}</div>`,
  () => `
    <h1 data-gpu-morph="title">Projects</h1>
    ${card(0, 'hero', '<p>Stone, water and a long horizon: the first of three studies, opened from the grid. Its box, image and title move here; this text fades in.</p>')}
    <div class="side">${[1, 2].map((i) => card(i, '')).join('')}</div>`
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
