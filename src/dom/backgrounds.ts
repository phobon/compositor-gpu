import type { ImageRecord, Rect } from '../scene/records'
import { splitTopLevel } from '../util/css'
import { paddingPlacement } from './pseudo'
import { mapBackgroundPosition, readCorners } from './styles'
import { type Placement, placementAabb } from './transform'

/**
 * The URL of the first `background-image` layer, or null when that layer
 * isn't a `url(...)` (a gradient, `none`, or unparsable). Only the first
 * layer is painted — later layers are a follow-up.
 */
export function firstUrlLayer(backgroundImage: string): string | null {
  if (!backgroundImage || backgroundImage === 'none') return null
  const first = splitTopLevel(backgroundImage, ',')[0]
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

/** url -> <img> (loading, loaded or failed), cached across calls. */
const cache = new Map<string, HTMLImageElement>()

interface Waiter {
  owner: object
  onReady: () => void
}

/** url -> callbacks to run when it settles, one per waiting element (a
 * re-read replaces the element's entry). Cleared on load or error. */
const waiters = new Map<string, Map<Element, Waiter>>()

function settle(url: string, loaded: boolean): void {
  const w = waiters.get(url)
  waiters.delete(url)
  if (!w || !loaded) return
  for (const { onReady } of w.values()) onReady()
}

/**
 * Returns the loaded image for `url` if it's ready to sample, else starts
 * (or continues) loading it and returns null. `crossOrigin` is set before
 * `src` so cross-origin images come back CORS-clean — WebGPU's
 * `copyExternalImageToTexture` refuses to upload a tainted image, which the
 * image pass can only surface as a logged failure, not a thrown error.
 * While it loads, `onReady` is registered for (`owner`, `el`) and runs once
 * when it finishes; nothing runs if it fails (a failed url stays cached and
 * is not retried). `disposeBackgrounds(owner)` drops an owner's callbacks.
 */
export function loadBackground(
  url: string,
  owner: object,
  el: Element,
  onReady: () => void
): HTMLImageElement | null {
  let img = cache.get(url)
  if (!img) {
    img = new Image()
    img.crossOrigin = 'anonymous'
    img.addEventListener('load', () => settle(url, true), { once: true })
    img.addEventListener('error', () => settle(url, false), { once: true })
    img.src = url
    cache.set(url, img)
  }
  if (img.complete) return img.naturalWidth > 0 ? img : null
  let w = waiters.get(url)
  if (!w) {
    w = new Map()
    waiters.set(url, w)
  }
  w.set(el, { owner, onReady })
  return null
}

/** Drop every pending background callback registered by `owner`. */
export function disposeBackgrounds(owner: object): void {
  for (const [url, w] of waiters) {
    for (const [el, waiter] of w) {
      if (waiter.owner === owner) w.delete(el)
    }
    if (w.size === 0) waiters.delete(url)
  }
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
 * loading, so the caller can re-read the element (see loadBackground for
 * `owner`).
 */
export function readBackgroundImage(
  el: Element,
  s: CSSStyleDeclaration,
  id: number,
  clip: Rect | null,
  owner: object,
  onReady: () => void,
  place: Placement
): ImageRecord | null {
  if (s.visibility !== 'visible') return null
  const url = firstUrlLayer(s.backgroundImage)
  if (!url) return null
  const img = loadBackground(url, owner, el, onReady)
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
