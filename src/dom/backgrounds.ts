import type { ImageRecord, Rect } from '../scene/records'
import { splitTopLevel } from '../util/css'
import {
  boxInset,
  insetCorners,
  mapBackgroundPosition,
  readCorners
} from './styles'
import { type Placement, placementAabb, subPlacement } from './transform'

/**
 * The URL of the first `background-image` layer, or null when that layer
 * isn't a `url(...)` (a gradient, `none`, or unparsable). Only the first
 * layer is painted — later layers are a follow-up.
 */
export function firstUrlLayer(backgroundImage: string): string | null {
  if (!backgroundImage || backgroundImage === 'none') {
    return null
  }
  const first = splitTopLevel(backgroundImage, ',')[0]
  if (!first) {
    return null
  }
  const match = /^url\((.*)\)$/is.exec(first.trim())
  if (!match) {
    return null
  }
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
  if (s === 'cover') {
    return 'cover'
  }
  if (s === 'contain') {
    return 'contain'
  }
  if (s === 'auto' || s === 'auto auto' || s === '') {
    return 'none'
  }
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
  if (!w || !loaded) {
    return
  }
  for (const { onReady } of w.values()) {
    onReady()
  }
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
  if (img.complete) {
    return img.naturalWidth > 0 ? img : null
  }
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
      if (waiter.owner === owner) {
        w.delete(el)
      }
    }
    if (w.size === 0) {
      waiters.delete(url)
    }
  }
}

/** Layer `i` of a comma list; the list repeats to cover every layer. */
function layerValue(list: string, i: number, fallback: string): string {
  const parts = splitTopLevel(list, ',')
  return (
    (parts.length ? (parts[i % parts.length] ?? '') : '').trim() || fallback
  )
}

/**
 * Build an ImageRecord for an element's first `background-image` url layer,
 * or null when there isn't one (none, a gradient, or still loading). Later
 * layers are not painted. `place` is the element's border-box placement
 * (see transform.ts).
 *
 * The record's local box is the layer's painting area (`background-clip`,
 * border-box by default) and its radii follow that box (outer radii minus
 * the insets). The tile/cover/contain area is the `background-origin` box
 * (padding-box by default), carried as `originInset` relative to the local
 * box. `background-clip` and `-origin` are read at the layer's index (0);
 * `text` clips as border-box. `onReady` is called once the image finishes
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
  if (s.visibility !== 'visible') {
    return null
  }
  const url = firstUrlLayer(s.backgroundImage)
  if (!url) {
    return null
  }
  const img = loadBackground(url, owner, el, onReady)
  if (!img) {
    return null
  }
  const clipBox = layerValue(s.backgroundClip, 0, 'border-box')
  const originBox = layerValue(s.backgroundOrigin, 0, 'padding-box')
  const ci = boxInset(s, clipBox)
  const oi = boxInset(s, originBox)
  const area = subPlacement(
    place,
    ci[3],
    ci[0],
    Math.max(0, place.local.w - ci[1] - ci[3]),
    Math.max(0, place.local.h - ci[0] - ci[2])
  )
  const origin: [number, number, number, number] = [
    oi[0] - ci[0],
    oi[1] - ci[1],
    oi[2] - ci[2],
    oi[3] - ci[3]
  ]
  if (
    area.local.w <= 0 ||
    area.local.h <= 0 ||
    area.local.w - origin[1] - origin[3] <= 0 ||
    area.local.h - origin[0] - origin[2] <= 0
  ) {
    return null
  }
  return {
    kind: 'image',
    id,
    rect: placementAabb(area),
    xform: area.xform,
    local: area.local,
    source: img,
    objectFit: mapBackgroundSize(s.backgroundSize),
    position: mapBackgroundPosition(s.backgroundPosition),
    repeat: mapBackgroundRepeat(s.backgroundRepeat),
    radius: insetCorners(
      readCorners(s, {
        x: 0,
        y: 0,
        width: place.local.w,
        height: place.local.h
      }),
      ci
    ),
    ...(origin.some((v) => v !== 0) ? { originInset: origin } : {}),
    opacity: 1,
    z: 0,
    clip,
    dynamic: false
  }
}
