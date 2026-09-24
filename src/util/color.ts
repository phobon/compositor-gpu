import type { RGBA } from '../scene/records'

const CANVAS_KEY = '__compositor_color_probe__'

/**
 * Parse any CSS color string into 0..1 RGBA by delegating to the browser (a
 * 1x1 canvas), so we accept exactly what CSS accepts. sRGB-encoded, straight
 * alpha; we blend in sRGB space to match the browser. Values are cached
 * because getComputedStyle hands back a small set of resolved colors.
 */
const cache = new Map<string, RGBA>()

function probeContext(): CanvasRenderingContext2D | null {
  const g = globalThis as unknown as Record<string, unknown>
  let ctx = g[CANVAS_KEY] as CanvasRenderingContext2D | undefined
  if (!ctx) {
    if (typeof document === 'undefined') return null
    const c = document.createElement('canvas')
    c.width = 1
    c.height = 1
    ctx = c.getContext('2d', { willReadFrequently: true }) ?? undefined
    if (ctx) g[CANVAS_KEY] = ctx
  }
  return ctx ?? null
}

export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 }

export function parseColor(css: string): RGBA {
  const cached = cache.get(css)
  if (cached) return cached
  const ctx = probeContext()
  if (!ctx) return TRANSPARENT
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = '#000'
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  const out: RGBA = {
    r: (r ?? 0) / 255,
    g: (g ?? 0) / 255,
    b: (b ?? 0) / 255,
    a: (a ?? 0) / 255
  }
  cache.set(css, out)
  return out
}
