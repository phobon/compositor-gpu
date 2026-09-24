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

const state = { animate: true }

async function boot(): Promise<void> {
  const stage = $('stage')

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
      $('s-images').textContent = String(s.images)
      $('s-uploads').textContent = String(s.uploads)
      $('s-batches').textContent = String(s.batches)
      $('s-read').textContent = String(s.readElements)
      $('s-partial').textContent = String(s.partialReads)
      $('s-fps').textContent = s.fps.toFixed(0)
      const ready = compositor.text?.ready ?? false
      $('s-text').textContent = ready ? 'ready' : 'loading'
      $('s-text').className = ready ? 'ok' : ''
    }
  })

  $('s-gpu').textContent = compositor.active ? 'yes' : 'no'
  $('s-gpu').className = compositor.active ? 'ok' : 'bad'
  $('s-state').textContent = compositor.active ? 'active' : 'passthrough'

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

  $('b-add').addEventListener('click', () => {
    const li = document.createElement('li')
    li.textContent = `Item ${mList.children.length + 1}`
    mList.appendChild(li)
  })
}

function animateLiveCanvas(): void {
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
    requestAnimationFrame(draw)
  }
  requestAnimationFrame(draw)
}

animateLiveCanvas()
void boot()
