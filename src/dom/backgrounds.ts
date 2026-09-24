import type { ImageRecord, Rect } from '../scene/records'
import { mapBackgroundPosition, px, readCorners } from './styles'
import { type Placement, placementAabb, subPlacement } from './transform'

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
 * The padding-box placement for an element's border-box placement `place`,
 * given its computed border widths (inset in the local frame).
 */
function paddingPlacement(s: CSSStyleDeclaration, place: Placement): Placement {
  const bl = px(s.borderLeftWidth)
  const bt = px(s.borderTopWidth)
  const br = px(s.borderRightWidth)
  const bb = px(s.borderBottomWidth)
  return subPlacement(
    place,
    bl,
    bt,
    Math.max(0, place.local.w - bl - br),
    Math.max(0, place.local.h - bt - bb)
  )
}

/**
 * Build an ImageRecord for an element's first `background-image` url layer,
 * or null when there isn't one (none, a gradient, or still loading).
 * `place` is the element's border-box placement (see transform.ts). The
 * tile/cover/contain area is the padding box (CSS `background-origin:
 * padding-box`, the default), so the record's local box is the border box
 * inset by the border widths (its `rect` is that box's doc-space AABB).
 * `ImageRecord` has only one local box, used for both placement and the
 * border-radius clip, so the clip ends up applied to the padding box too
 * — a minor approximation (the border ring itself isn't otherwise clipped
 * by the radius here anyway). `onReady` is called once the image finishes
 * loading, so the caller can re-read the element.
 */
export function readBackgroundImage(
  el: Element,
  s: CSSStyleDeclaration,
  id: number,
  clip: Rect | null,
  onReady: (url: string) => void,
  place: Placement
): ImageRecord | null {
  const url = firstUrlLayer(s.backgroundImage)
  if (!url) return null
  const img = loadBackground(url, onReady)
  if (!img) return null
  const pad = paddingPlacement(s, place)
  if (pad.local.w <= 0 || pad.local.h <= 0) return null
  return {
    kind: 'image',
    id,
    rect: placementAabb(pad),
    xform: pad.xform,
    local: pad.local,
    source: img,
    objectFit: mapBackgroundSize(s.backgroundSize),
    position: mapBackgroundPosition(s.backgroundPosition),
    repeat: mapBackgroundRepeat(s.backgroundRepeat),
    radius: readCorners(s, {
      x: 0,
      y: 0,
      width: place.local.w,
      height: place.local.h
    }),
    opacity: 1,
    z: 0,
    clip,
    dynamic: false
  }
}
