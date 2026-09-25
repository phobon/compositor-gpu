import type { RGBA } from '../scene/records'

const CANVAS_KEY = '__compositor_color_probe__'

/**
 * Parse any CSS color string into 0..1 RGBA by delegating to the browser (a
 * 1x1 canvas), so we accept exactly what CSS accepts. sRGB-encoded, straight
 * alpha; we blend in sRGB space to match the browser. Values are cached
 * (bounded) because getComputedStyle hands back a small set of resolved
 * colors.
 */
const cache = new Map<string, RGBA | null>()

function probeContext(): CanvasRenderingContext2D | null {
  const g = globalThis as unknown as Record<string, unknown>
  let ctx = g[CANVAS_KEY] as CanvasRenderingContext2D | undefined
  if (!ctx) {
    if (typeof document === 'undefined') {
      return null
    }
    const c = document.createElement('canvas')
    c.width = 1
    c.height = 1
    ctx = c.getContext('2d', { willReadFrequently: true }) ?? undefined
    if (ctx) {
      g[CANVAS_KEY] = ctx
    }
  }
  return ctx ?? null
}

export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 }

const CACHE_MAX = 1024

/** Paint `css` over a sentinel fill and read the pixel back. */
function probe(ctx: CanvasRenderingContext2D, sentinel: string, css: string) {
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = sentinel
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  return ctx.getImageData(0, 0, 1, 1).data
}

/**
 * Parse a CSS colour, or null when the browser rejects it. An invalid
 * assignment to `fillStyle` is ignored, so the value is probed over two
 * different sentinel fills: if the reads differ, the sentinel survived
 * and the value was invalid.
 */
export function tryParseColor(css: string): RGBA | null {
  const cached = cache.get(css)
  if (cached !== undefined) {
    return cached
  }
  const ctx = probeContext()
  if (!ctx) {
    return null
  }
  const a = probe(ctx, '#010203', css)
  const [r = 0, g = 0, b = 0, al = 0] = a
  const [r2, g2, b2, al2] = probe(ctx, '#fdfeff', css)
  const out: RGBA | null =
    r === r2 && g === g2 && b === b2 && al === al2
      ? { r: r / 255, g: g / 255, b: b / 255, a: al / 255 }
      : null
  if (cache.size >= CACHE_MAX) {
    cache.clear()
  }
  cache.set(css, out)
  return out
}

/** Parse any CSS colour; TRANSPARENT when invalid (see tryParseColor). */
export function parseColor(css: string): RGBA {
  return tryParseColor(css) ?? TRANSPARENT
}
