import { createCompositor } from '@/index'

const $ = (id: string) => document.getElementById(id) as HTMLElement
const logEl = $('log')

// Surface console.error (incl. shader/validation errors) onto the page.
const origErr = console.error.bind(console)
console.error = (...args: unknown[]) => {
  origErr(...args)
  logEl.textContent += `${args.join(' ')}\n`
}
window.addEventListener('error', (e) => {
  logEl.textContent += `${e.message}\n`
})

// `?vr` selects deterministic capture mode for the visual-regression harness:
// no glyph animation, live canvas frozen after one frame.
const vrMode = new URLSearchParams(location.search).has('vr')
const state = { animate: !vrMode }
// Starts the CSS spinner animation; `vr` creates it already paused, so its
// angle is deterministic (see `body.vr` in index.html). Set before the
// compositor's first read.
document.body.classList.add(vrMode ? 'vr' : 'live')

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
  const stage = $('stage')

  if (vrMode) $('b-animate').setAttribute('aria-pressed', 'false')

  const compositor = await createCompositor({
    root: stage,
    layers: ['boxes', 'images', 'text'],
    fonts: 'auto',
    onGlyph: (g, ctx) => {
      g.offset.y = state.animate
        ? Math.sin(ctx.time / 300 + g.index * 0.5) * 6
        : 0
    },
    onFrame: () => {
      const s = compositor.stats()
      $('s-boxes').textContent = String(s.boxes)
      $('s-glyphs').textContent = String(s.glyphs)
      $('s-fallback').textContent = String(s.fallback)
      $('s-images').textContent = String(s.images)
      $('s-uploads').textContent = String(s.uploads)
      $('s-batches').textContent = String(s.batches)
      $('s-groups').textContent = String(s.groups)
      $('s-read').textContent = String(s.readElements)
      $('s-read-ms').textContent = s.readMs.toFixed(2)
      $('s-partial').textContent = String(s.partialReads)
      $('s-encode-ms').textContent = s.encodeMs.toFixed(2)
      $('s-fps').textContent = s.fps.toFixed(0)
      const ready = compositor.text?.ready ?? false
      $('s-text').textContent = ready ? 'ready' : 'loading'
      $('s-text').className = ready ? 'ok' : ''
    }
  })

  $('s-gpu').textContent = compositor.active ? 'yes' : 'no'
  $('s-gpu').className = compositor.active ? 'ok' : 'bad'
  $('s-state').textContent = compositor.active ? 'active' : 'passthrough'

  const textReady = (): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (!compositor.text || compositor.text.ready) resolve()
        else requestAnimationFrame(check)
      }
      check()
    })

  window.__vr = {
    ready: (async () => {
      if (!compositor.active) return
      await textReady()
      await document.fonts.ready
      await imagesReady()
      await raf2()
    })(),
    async setMode(mode) {
      const cv = compositor.canvas
      if (cv) {
        if (mode === 'dom') {
          compositor.setSourceHidden(false)
          cv.style.visibility = 'hidden'
        } else if (mode === 'gpu') {
          compositor.setSourceHidden(true)
          cv.style.visibility = 'visible'
        } else {
          compositor.setSourceHidden(false)
          cv.style.visibility = 'visible'
        }
      }
      await raf2()
    },
    stats: () => compositor.stats()
  }

  if (!compositor.active) {
    logEl.textContent = 'WebGPU unavailable — showing the plain DOM.'
    return
  }

  // Fonts are discovered from the page's @font-face rules by fonts:'auto'
  // above, fetched and parsed at runtime — no manual loadFontBuffer needed.
  compositor.start()
  // Images may finish decoding after the first walk; re-read once loaded.
  window.addEventListener('load', () => compositor.invalidate())

  // --- controls ---
  // Replace mode: hide the DOM's own paint (still selectable / accessible) and
  // let the GPU layer stand in for it.
  const gpuOnly = $('b-gpuonly')
  gpuOnly.addEventListener('click', () => {
    const on = gpuOnly.getAttribute('aria-pressed') !== 'true'
    compositor.setSourceHidden(on)
    gpuOnly.setAttribute('aria-pressed', String(on))
  })

  const animate = $('b-animate')
  animate.addEventListener('click', () => {
    state.animate = !state.animate
    animate.setAttribute('aria-pressed', String(state.animate))
  })

  const toggle = $('b-toggle')
  let running = true
  toggle.addEventListener('click', () => {
    running = !running
    if (running) compositor.start()
    else compositor.stop()
    toggle.setAttribute('aria-pressed', String(running))
    toggle.textContent = running ? 'GPU layer on' : 'GPU layer off'
  })

  // Mutation demo buttons
  const mText = $('m-text')
  const mList = $('m-list')
  const mCard = document.querySelector('.mutdemo') as HTMLElement | null

  $('b-edit').addEventListener('click', () => {
    mText.textContent =
      mText.textContent === 'Hello World' ? 'Hi there' : 'Hello World'
  })

  $('b-class').addEventListener('click', () => {
    mCard?.classList.toggle('hot')
  })

  // A live CSS animation: no mutation records while it runs, so this
  // checks the compositor's transition/animation tracking.
  $('b-spin').addEventListener('click', () => {
    $('xf-card').classList.toggle('spin')
  })

  $('b-add').addEventListener('click', () => {
    const li = document.createElement('li')
    li.textContent = `Item ${mList.children.length + 1}`
    mList.appendChild(li)
  })
}

function animateLiveCanvas({ once }: { once: boolean }): void {
  const cv = document.querySelector('.livecanvas') as HTMLCanvasElement | null
  const ctx = cv?.getContext('2d')
  if (!cv || !ctx) return
  const draw = (t: number): void => {
    ctx.fillStyle = '#101018'
    ctx.fillRect(0, 0, cv.width, cv.height)
    for (let i = 0; i < 7; i++) {
      const x = cv.width * (0.5 + 0.44 * Math.sin(t / 720 + i * 0.8))
      const y = cv.height * 0.5 + Math.sin(t / 480 + i) * 34
      ctx.beginPath()
      ctx.arc(x, y, 28, 0, Math.PI * 2)
      ctx.fillStyle = `hsl(${((t / 18 + i * 52) % 360).toFixed(0)} 82% 62%)`
      ctx.fill()
    }
    if (!once) requestAnimationFrame(draw)
  }
  // Under `?vr` a single deterministic frame is drawn directly (a real rAF
  // timestamp would differ between harness runs and break the diff).
  if (once) draw(1000)
  else requestAnimationFrame(draw)
}

animateLiveCanvas({ once: vrMode })
void boot()
