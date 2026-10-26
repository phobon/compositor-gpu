/// <reference path="./transition.d.ts" />
// typegpu reads process.env at evaluation: the shim must run first.
import '@/util/env'
import './nav'
import { createEffects, lens, radialReveal } from '@/fx'
import { createCompositor } from '@/index'
import { estimateRefresh, summarize } from '@/profile/profiler'

// Transition playground: two page states swapped under fx.transition, a
// radialReveal from the pointer. Next / Prev, or `?auto` runs
// `?n=20` transitions (`?ms=600` each) under the profiler and leaves the
// results on window.__tr (test/transition/run.ts prints them).
// `?progress=p` holds every transition at p (fx harness captures).

const q = new URLSearchParams(location.search)
const page = document.getElementById('page') as HTMLElement
let version = 0

const STATES = [
  (v: number) => `
    <h1>Section I</h1>
    <p>Two states of one page. The outgoing one is held as a snapshot
      while the incoming one is mirrored, then revealed from the
      pointer.</p>
    <div class="row">
      <img src="./test.png?v=${v}a" alt="" />
      <img src="./test.png?v=${v}b" alt="" />
      <img src="./test.png?v=${v}c" alt="" />
    </div>`,
  (v: number) => `
    <h1>Section II</h1>
    <p>A different layout and fresh image URLs each time, so every swap
      waits on decodes and uploads before the reveal starts.</p>
    <div class="row">
      <img src="./test.png?v=${v}d" alt="" />
      <img src="./test.png?v=${v}e" alt="" />
    </div>`
]
let state = 0
const show = (s: number): void => {
  state = s
  version++
  page.className = s === 0 ? 'a' : 'b'
  page.innerHTML = STATES[s]?.(version) ?? ''
}
show(0)

const compositor = await createCompositor({ root: page, mode: 'replace' })
compositor.start()
await compositor.ready
const fx = createEffects(compositor)
Object.assign(window, { __gpu: compositor })

// The circle's centre is set per transition (the pointer, or scripted).
const reveal = radialReveal(fx, { fromPointer: false })
// `?lens`: a lens on the pointer over everything, for trying by hand.
lens(fx, { enabled: q.has('lens'), radius: 120 })

const raf = (): Promise<number> => new Promise((r) => requestAnimationFrame(r))
const ease = (t: number): number => 1 - (1 - t) ** 3

const results: { settleMs: number; captureMs: number }[] = []
const windows: [number, number][] = []
let shown = 0
let busy = false

/** One transition to state `to`, revealed from `center` (uv). */
async function go(to: number, center: [number, number], ms: number) {
  if (busy) {
    return
  }
  busy = true
  const t0 = performance.now()
  reveal.params.center = center
  reveal.params.progress = 0
  await reveal.capture()
  const t1 = performance.now()
  show(to)
  await reveal.settled()
  const t2 = performance.now()
  results.push({ captureMs: t1 - t0, settleMs: t2 - t1 })
  const hold = q.get('progress')
  if (hold !== null) {
    reveal.params.progress = Number(hold)
    busy = false
    return
  }
  const start = await raf()
  for (let t = start; t - start < ms; t = await raf()) {
    // Source paint showing through: the hidden root painting again.
    if (getComputedStyle(page).opacity !== '0') {
      shown++
    }
    reveal.params.progress = ease((t - start) / ms)
  }
  reveal.params.progress = 1
  await raf()
  windows.push([start, performance.now()])
  reveal.end()
  busy = false
}

const pointerUv = (): [number, number] => {
  const p = fx.pointer
  return p.seen
    ? [p.x / window.innerWidth, p.y / window.innerHeight]
    : [0.5, 0.5]
}
const ms = Number(q.get('ms') ?? 600)
document.getElementById('next')?.addEventListener('click', () => {
  void go(1 - state, pointerUv(), ms)
})
document.getElementById('prev')?.addEventListener('click', () => {
  void go(1 - state, pointerUv(), ms)
})

window.__tr = {
  done: false,
  results,
  go: (to, center) => go(to, center, ms),
  reveal
}

if (q.has('auto')) {
  const n = Number(q.get('n') ?? 20)
  compositor.profile.start()
  for (let i = 0; i < n; i++) {
    const c: [number, number] = [
      0.15 + 0.7 * ((i * 0.37) % 1),
      0.3 + 0.4 * (i % 2)
    ]
    await go(1 - state, c, ms)
    for (let k = 0; k < 12; k++) {
      await raf()
    }
  }
  const report = await compositor.profile.stop()
  if (report) {
    const all = report.samples
    const during = all.filter((s) =>
      windows.some(([a, b]) => s.t >= a && s.t <= b)
    )
    window.__tr.summary = summarize(during, estimateRefresh(all))
  }
  window.__tr.shown = shown
  window.__tr.done = true
}
