/// <reference path="./perf.d.ts" />
import { blur, createEffects } from '@/fx'
import { createCompositor } from '@/index'

// Perf harness fixture: builds an N-card grid, boots the compositor with
// the same options as the main playground, and exposes window.__perf for
// test/perf/run.ts to drive (full reads, partial reads, steady frames).

const WORDS = [
  'The',
  'compositor',
  'walks',
  'a',
  'live',
  'DOM',
  'tree',
  'and',
  'mirrors',
  'every',
  'box',
  'onto',
  'the',
  'GPU',
  'while',
  'the',
  'browser',
  'keeps',
  'doing',
  'layout',
  'text',
  'shaping',
  'and',
  'hit',
  'testing',
  'so',
  'nothing',
  'about',
  'the',
  'page',
  'has',
  'to',
  'change',
  'to',
  'get',
  'a',
  'faster',
  'paint',
  'underneath',
  'it'
]

function paragraphHtml(seed: number): string {
  const words: string[] = []
  for (let i = 0; i < 30; i++) {
    const w = WORDS[(seed + i) % WORDS.length] ?? 'word'
    words.push(i === 3 ? `<b>${w}</b>` : i === 9 ? `<i>${w}</i>` : w)
  }
  // A dedicated span for mutate('text') to toggle without changing layout
  // width (same length replacement keeps the partial read from escalating).
  words.splice(15, 0, '<span class="mword">quickly</span>')
  words.splice(22, 0, '<a href="#">a linked reference</a>')
  return words.join(' ')
}

function buildCard(index: number): HTMLElement {
  const card = document.createElement('div')
  card.className = 'pcard'
  if ((index + 1) % 10 === 0) {
    card.classList.add('rot')
  }
  if ((index + 1) % 7 === 0) {
    card.classList.add('dim')
  }

  const h = document.createElement('h3')
  h.textContent = `Card ${index + 1}`
  card.appendChild(h)

  const p = document.createElement('p')
  p.innerHTML = paragraphHtml(index)
  card.appendChild(p)

  const ul = document.createElement('ul')
  for (let i = 0; i < 3; i++) {
    const li = document.createElement('li')
    li.textContent = `Detail ${i + 1} for card ${index + 1}`
    ul.appendChild(li)
  }
  card.appendChild(ul)

  const img = document.createElement('img')
  img.src = './test.png'
  img.alt = ''
  card.appendChild(img)

  return card
}

// Each card sits in its own wrapper so a class toggle on the card (an
// attributes mutation, scoped to its parent per dom/observer.ts) re-reads
// just that one card's subtree, not the whole grid — #stage would otherwise
// be the card's direct parent and the scope.
function buildWrappedCard(index: number): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'pwrap'
  wrap.appendChild(buildCard(index))
  return wrap
}

function buildGrid(n: number): void {
  const stage = document.getElementById('stage') as HTMLElement
  const frag = document.createDocumentFragment()
  for (let i = 0; i < n; i++) {
    frag.appendChild(buildWrappedCard(i))
  }
  stage.appendChild(frag)
}

function raf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

async function raf2(): Promise<void> {
  await raf()
  await raf()
}

function imagesReady(): Promise<void> {
  const imgs = Array.from(document.images)
  return Promise.all(
    imgs.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true })
            img.addEventListener('error', () => resolve(), { once: true })
          })
    )
  ).then(() => undefined)
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search)
  const n = Math.max(1, Number(params.get('n')) || 400)
  const stage = document.getElementById('stage') as HTMLElement
  buildGrid(n)

  const compositor = await createCompositor({
    root: stage,
    layers: ['boxes', 'images', 'text'],
    fonts: 'auto'
    // No onGlyph: the perf fixture stays static, matching main.ts's
    // non-animated ?vr mode, so nothing dirties the text layer every frame.
  })

  const textReady = (): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (!compositor.text || compositor.text.ready) {
          resolve()
        } else {
          requestAnimationFrame(check)
        }
      }
      check()
    })

  let mutateCounter = 0
  // A fullscreen blur for the `steady encode (blur)` row, off until asked.
  const fx = createEffects(compositor)
  const blurPass = blur(fx, { enabled: false })

  window.__gpu = compositor
  const inView = (max: number): HTMLElement[] => {
    const vh = window.innerHeight
    return (Array.from(document.querySelectorAll('.pcard')) as HTMLElement[])
      .filter((c) => {
        const r = c.getBoundingClientRect()
        return r.bottom > 0 && r.top < vh
      })
      .slice(0, max)
  }
  // Scenarios for test/profile/run.ts: each runs a fixed number of frames
  // inside one recording.
  let scale = 1
  /** `n` frames, scaled by the scenario's `scale`. */
  const k = (n: number): number => Math.max(2, Math.round(n * scale))
  const scenarios: Record<string, () => Promise<void>> = {
    // Nothing changes: any frame recorded is something invalidating.
    async idle() {
      await new Promise((r) => setTimeout(r, k(1500)))
    },
    // 8 px per frame down then back up.
    async scroll() {
      for (let f = 0, n = k(240); f < n; f++) {
        window.scrollBy(0, f < n / 2 ? 8 : -8)
        await raf()
      }
    },
    // A text edit every frame (partial reads).
    async mutate() {
      for (let f = 0, n = k(120); f < n; f++) {
        window.__perf?.mutate(f % 2 ? 'text' : 'class')
        await raf()
      }
    },
    // A full read every 10th frame (the worst case, spaced out).
    async 'full-read'() {
      for (let f = 0, n = k(120); f < n; f++) {
        if (f % 10 === 0) {
          compositor.invalidate()
        }
        await raf()
      }
    },
    async 'css-transforms'() {
      await window.__perf?.animate('dom', k(120))
    },
    async 'fx-transforms'() {
      await window.__perf?.animate('gpu', k(120))
    },
    // The /duo bento reveal: cards in view fade and rise through
    // fx.transform, staggered, each blurred by its own region pass whose
    // radius falls to 0; then the passes go away.
    async reveal() {
      const cards = inView(12)
      const tfs = cards.map((c) => fx.transform(c))
      const blurs = cards.map((c) => blur(fx, { region: c, radius: 14 }))
      const frames = k(72)
      const stagger = Math.max(1, Math.round(4 * scale))
      for (let f = 0; f < frames + stagger * cards.length; f++) {
        cards.forEach((_, i) => {
          const p = Math.min(1, Math.max(0, (f - i * stagger) / frames))
          const e = 1 - (1 - p) ** 3
          const t = tfs[i]
          const b = blurs[i]
          if (t) {
            t.opacity = e
            t.y = 40 * (1 - e)
            t.scale = 0.92 + 0.08 * e
          }
          if (b) {
            b.params.radius = 14 * (1 - e)
            b.enabled = p < 1
          }
        })
        await raf()
      }
      for (const b of blurs) {
        b.destroy()
      }
      for (const t of tfs) {
        t.destroy()
      }
      await raf2()
    },
    // A fullscreen blur pass while scrolling.
    async 'blur-scroll'() {
      blurPass.enabled = true
      for (let f = 0, n = k(120); f < n; f++) {
        window.scrollBy(0, f < n / 2 ? 8 : -8)
        await raf()
      }
      blurPass.enabled = false
      await raf2()
    }
  }

  window.__perf = {
    async scenario(name: string, frames = 1) {
      scale = frames
      const run = scenarios[name]
      if (!run) {
        throw new Error(`unknown scenario ${name}`)
      }
      window.scrollTo(0, 0)
      await raf2()
      compositor.profile.start()
      await run()
      return compositor.profile.stop()
    },
    ready: (async () => {
      if (!compositor.active) {
        return
      }
      await textReady()
      await document.fonts.ready
      await imagesReady()
      await raf2()
    })(),
    stats: () => compositor.stats(),
    invalidate: () => compositor.invalidate(),
    setBlur(on: boolean) {
      blurPass.enabled = on
    },
    async animate(mode: 'dom' | 'gpu', frames: number) {
      // Scale and lift the cards in view each frame: through their CSS
      // transform (re-read by the compositor) or fx.transform (no DOM
      // write). Frame interval and the compositor's CPU time per frame.
      const vh = window.innerHeight
      const cards = Array.from(document.querySelectorAll('.pcard'))
        .filter((c) => {
          const r = c.getBoundingClientRect()
          return r.bottom > 0 && r.top < vh
        })
        .slice(0, 30) as HTMLElement[]
      const tfs = mode === 'gpu' ? cards.map((c) => fx.transform(c)) : []
      await raf2()
      await raf2()
      const frameMs: number[] = []
      const cpuMs: number[] = []
      let last = performance.now()
      for (let f = 0; f < frames; f++) {
        cards.forEach((c, i) => {
          const s = 0.9 + 0.1 * Math.abs(Math.sin((f + i) / 8))
          const y = (1 - s) * 60
          const t = tfs[i]
          if (t) {
            t.scale = s
            t.y = y
          } else {
            c.style.transform = `translateY(${y}px) scale(${s})`
          }
        })
        const now = await new Promise<number>((r) =>
          requestAnimationFrame((t) => r(t))
        )
        frameMs.push(now - last)
        last = now
        cpuMs.push(compositor.stats().frameMs)
      }
      for (const t of tfs) {
        t.destroy()
      }
      for (const c of cards) {
        c.style.transform = ''
      }
      await raf2()
      return { cards: cards.length, frameMs, cpuMs }
    },
    mutate(kind: 'text' | 'class' | 'append') {
      const stage2 = document.getElementById('stage') as HTMLElement
      if (kind === 'text') {
        const word = stage2.querySelector('.mword')
        if (word) {
          word.textContent =
            word.textContent === 'quickly' ? 'briskly' : 'quickly'
        }
      } else if (kind === 'class') {
        const first = stage2.querySelector('.pcard')
        first?.classList.toggle('hot')
      } else if (kind === 'append') {
        mutateCounter++
        stage2.appendChild(buildWrappedCard(n + mutateCounter))
      }
    }
  }

  if (!compositor.active) {
    return
  }
  compositor.start()
}

void boot()
