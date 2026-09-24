import type { ImageRecord, Rect } from '../scene/records'
import { readCorners } from './styles'

/**
 * Split a CSS value list on top-level commas (commas inside parentheses,
 * e.g. `rgba(0,0,0,.5)` or `url(data:...,...)`, don't split).
 */
function splitTopLevel(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of value) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}

/**
 * The URL of the first `background-image` layer, or null when that layer
 * isn't a `url(...)` (a gradient, `none`, or unparsable). Only the first
 * layer is painted — later layers are a follow-up.
 */
export function firstUrlLayer(backgroundImage: string): string | null {
  if (!backgroundImage || backgroundImage === 'none') return null
  const first = splitTopLevel(backgroundImage)[0]
  if (!first) return null
  const match = /^url\((.*)\)$/is.exec(first.trim())
  if (!match) return null
  let inner = (match[1] ?? '').trim()
  if (
    (inner.startsWith('"') && inner.endsWith('"')) ||
    (inner.startsWith("'") && inner.endsWith("'"))
  ) {
    inner = inner.slice(1, -1)
  }
  return inner || null
}

/** background-size -> ImageRecord.objectFit (approximation: anything that
 * isn't cover/contain/auto is treated as 'fill', including two-length forms
 * like `100% 100%` that could in principle differ per axis). */
export function mapBackgroundSize(
  size: string
): 'fill' | 'contain' | 'cover' | 'none' {
  const s = size.trim()
  if (s === 'cover') return 'cover'
  if (s === 'contain') return 'contain'
  if (s === 'auto' || s === 'auto auto' || s === '') return 'none'
  return 'fill'
}

/** One background-position component -> a 0..1 fraction of the free space.
 * Percentages map directly; keywords resolve to their CSS fraction; a
 * length (px etc.) can't be turned into a fraction without knowing the free
 * space here, so it's clamped to 0 or 1 by sign (an approximation). */
function positionComponent(token: string): number | null {
  if (token === 'center') return 0.5
  if (token === 'left' || token === 'top') return 0
  if (token === 'right' || token === 'bottom') return 1
  if (token.endsWith('%')) {
    const n = Number.parseFloat(token)
    return Number.isFinite(n) ? n / 100 : null
  }
  const n = Number.parseFloat(token)
  if (!Number.isFinite(n)) return null
  return n <= 0 ? 0 : 1
}

/** background-position -> [x, y] fractions. Defaults to [0, 0] (the
 * ImageRecord default for backgrounds) whenever it can't be parsed. */
export function mapBackgroundPosition(position: string): [number, number] {
  const tokens = position.trim().split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return [0, 0]
  const x = positionComponent(tokens[0] ?? '') ?? 0
  const y = positionComponent(tokens[1] ?? '') ?? 0
  return [x, y]
}

/** background-repeat -> whether the image tiles. Only exact `no-repeat`
 * turns tiling off; `repeat-x`/`repeat-y`/`space`/`round` are approximated
 * as tiling (fit 'none' repeats both axes; see imageRenderer.ts). */
export function mapBackgroundRepeat(repeat: string): boolean {
  return repeat.trim() !== 'no-repeat'
}

/** url -> loaded <img>, cached across calls. */
const cache = new Map<string, HTMLImageElement>()

/**
 * Returns the loaded image for `url` if it's ready to sample, else starts
 * (or continues) loading it and returns null. `crossOrigin` is set before
 * `src` so cross-origin images come back CORS-clean — WebGPU's
 * `copyExternalImageToTexture` refuses to upload a tainted image, which the
 * image pass can only surface as a logged failure, not a thrown error.
 * `onReady` fires once per url, the first time it finishes loading (or not
 * at all if it errors).
 */
export function loadBackground(
  url: string,
  onReady: (url: string) => void
): HTMLImageElement | null {
  let img = cache.get(url)
  if (!img) {
    img = new Image()
    img.crossOrigin = 'anonymous'
    img.addEventListener('load', () => onReady(url), { once: true })
    img.src = url
    cache.set(url, img)
  }
  if (img.complete && img.naturalWidth > 0) return img
  return null
}

/**
 * Build an ImageRecord for an element's first `background-image` url layer,
 * or null when there isn't one (none, a gradient, or still loading).
 * `rect` is the element's doc-space border box, used as the background
 * positioning area — the CSS default is actually the padding-box, so this
 * is an approximation that ignores border width. `onReady` is called once
 * the image finishes loading, so the caller can re-read the element.
 */
export function readBackgroundImage(
  el: Element,
  s: CSSStyleDeclaration,
  rect: Rect,
  id: number,
  clip: Rect | null,
  onReady: (url: string) => void
): ImageRecord | null {
  const url = firstUrlLayer(s.backgroundImage)
  if (!url) return null
  const img = loadBackground(url, onReady)
  if (!img) return null
  if (rect.width <= 0 || rect.height <= 0) return null
  return {
    kind: 'image',
    id,
    rect,
    source: img,
    objectFit: mapBackgroundSize(s.backgroundSize),
    position: mapBackgroundPosition(s.backgroundPosition),
    repeat: mapBackgroundRepeat(s.backgroundRepeat),
    radius: readCorners(s),
    opacity: 1,
    z: 0,
    clip,
    dynamic: false
  }
}
