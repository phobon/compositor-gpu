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
    onGlyph: (g, ctx) => {
      g.offset.y = state.animate
        ? Math.sin(ctx.time / 300 + g.index * 0.5) * 6
        : 0
    },
    onFrame: () => {
      const s = compositor.stats()
      $('s-boxes').textContent = String(s.boxes)
      $('s-glyphs').textContent = String(s.glyphs)
      $('s-fps').textContent = s.fps.toFixed(0)
    }
  })

  $('s-gpu').textContent = compositor.active ? 'yes' : 'no'
  $('s-gpu').className = compositor.active ? 'ok' : 'bad'
  $('s-state').textContent = compositor.active ? 'active' : 'passthrough'

  if (!compositor.active) {
    logEl.textContent = 'WebGPU unavailable — showing the plain DOM.'
    return
  }

  // Register two weights (Inter 400 + 700, OFL). Runs resolve per weight.
  try {
    const faces: Array<[string, number]> = [
      ['./inter-400.ttf', 400],
      ['./inter-700.ttf', 700]
    ]
    for (const [url, weight] of faces) {
      const res = await fetch(url)
      if (res.ok) {
        compositor.text?.loadFontBuffer(await res.arrayBuffer(), {
          family: 'Inter Play',
          weight
        })
      }
    }
    const ok = compositor.text?.ready ?? false
    $('s-text').textContent = ok ? 'ready' : 'no font'
    $('s-text').className = ok ? 'ok' : 'bad'
  } catch (err) {
    $('s-text').textContent = 'font error'
    console.error('font load:', err)
  }

  compositor.start()

  // --- controls ---
  const gpuOnly = $('b-gpuonly')
  gpuOnly.addEventListener('click', () => {
    const on = stage.classList.toggle('gpu-only')
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
}

void boot()
