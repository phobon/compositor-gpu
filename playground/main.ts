import { createCompositor } from '@/index'

async function boot(): Promise<void> {
  const compositor = await createCompositor({
    debug: true,
    layers: ['boxes', 'text'],
    onGlyph: (g, ctx) => {
      g.offset.y = Math.sin(ctx.time / 300 + g.index * 0.5) * 4
    }
  })

  if (!compositor.active) {
    console.warn('WebGPU unavailable — showing the plain DOM (passthrough).')
    return
  }

  // Optional: feed a font so the text pass has outlines to paint.
  // Drop a .ttf into playground/ and point at it here.
  try {
    const res = await fetch('/font.ttf')
    if (res.ok) {
      compositor.text?.loadFontBuffer(await res.arrayBuffer(), 0)
    }
  } catch {
    console.info('No /font.ttf found — boxes render; text needs a font.')
  }

  compositor.start()
}

void boot()
