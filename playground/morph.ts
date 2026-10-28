/// <reference path="./morph.d.ts" />
// typegpu reads process.env at evaluation: the shim must run first.
import '@/util/env'
import './nav'
import { createEffects, morph, shockwave } from '@/fx'
import { createCompositor } from '@/index'

// Morph playground (M5d, in-place text): the heading's text changes
// through fx `morph`, glyph segments re-forming as the next string, under
// a shockwave. Next plays one; Assemble and Scatter break the heading
// into flying segments and back; `?auto` cycles; `?vr` is the harness
// view (window.__morph holds a morph at any progress).

const q = new URLSearchParams(location.search)
const vr = q.has('vr')
const STRINGS = ['83', 'S<sup>15</sup>_', '32<sup>*</sup>', '5/6']
const word = document.getElementById('word') as HTMLElement

// `?baked`: the heading and text drawn from baked fonts (npm run bake:playground).
const compositor = await createCompositor({
  mode: 'replace',
  ...(q.has('baked') ? { assets: '/gpu/manifest.json' } : {})
})
compositor.start()
await compositor.ready
const fx = createEffects(compositor)
const wave = shockwave(fx)
const m = morph(fx, word, { pieces: Number(q.get('pieces') ?? 16) })
const waveBox = document.getElementById('wave') as HTMLInputElement

let at = 0
let busy = false
const next = async (): Promise<void> => {
  if (busy) {
    return
  }
  busy = true
  at = (at + 1) % STRINGS.length
  await m.capture()
  word.innerHTML = STRINGS[at] ?? ''
  await m.settled()
  if (waveBox.checked) {
    wave.play(word)
  }
  await m.play(Number(q.get('ms') ?? 1100))
  busy = false
}

document.getElementById('next')?.addEventListener('click', () => {
  void next()
})

// Assemble: the heading flies together from scattered segments. Scatter:
// it flies apart, then assembles again.
const ms = Number(q.get('ms') ?? 1100)
const assembleNow = async (): Promise<void> => {
  if (busy) {
    return
  }
  busy = true
  await m.capture()
  m.assemble()
  if (waveBox.checked) {
    wave.play(word)
  }
  await m.play(ms)
  busy = false
}
const scatterNow = async (): Promise<void> => {
  if (busy) {
    return
  }
  busy = true
  await m.capture()
  m.scatter()
  await m.play(ms, undefined, true)
  await new Promise((r) => setTimeout(r, 500))
  m.assemble()
  await m.play(ms)
  busy = false
}
document.getElementById('assemble')?.addEventListener('click', () => {
  void assembleNow()
})
document.getElementById('scatter')?.addEventListener('click', () => {
  void scatterNow()
})
if (q.has('auto') && !vr) {
  const loop = async (): Promise<void> => {
    await next()
    setTimeout(() => void loop(), 700)
  }
  void loop()
}

window.__morph = {
  morph: m,
  async hold(i, progress) {
    await m.capture()
    word.innerHTML = STRINGS[i] ?? ''
    await m.settled()
    m.progress = progress
  },
  at(progress) {
    m.progress = progress
  },
  async pose(mode, progress) {
    await m.capture()
    if (mode === 'assemble') {
      m.assemble()
    } else {
      m.scatter()
    }
    m.progress = progress
  },
  end() {
    m.end()
  },
  async run(kind, playMs) {
    // One morph as Next / Assemble / Scatter play it, timed for the M5
    // budget (test/profile/run.ts --morph).
    const t0 = performance.now()
    await m.capture()
    const captureMs = performance.now() - t0
    if (kind === 'text' || kind === 'text-wave') {
      at = (at + 1) % STRINGS.length
      word.innerHTML = STRINGS[at] ?? ''
      await m.settled()
    }
    const start = performance.now()
    if (kind === 'assemble' || kind === 'scatter') {
      if (kind === 'assemble') {
        m.assemble()
      } else {
        m.scatter()
      }
    }
    if (kind === 'text-wave') {
      wave.play(word)
    }
    await m.play(playMs)
    return { captureMs, start, end: performance.now() }
  }
}
Object.assign(window, { __gpu: compositor, __fx: fx })
