import type { ImageRecord, Rect } from '../scene/records'
import { readCorners } from './styles'
import type { Placement } from './transform'

// Inline <svg> icons (a chevron in a round button, logos) are otherwise
// walked as ordinary elements and paint nothing — there is no box/image
// record for raw vector markup. An inline svg ROOT (ownerSVGElement ===
// null, i.e. its parent isn't itself SVG) is instead rasterised once as a
// data: URI and rendered as a single ImageRecord through the existing SVG
// display-size rasterisation path in imageRenderer.ts (isSvgSource);
// tree.ts skips walking its children entirely — nothing inside an svg
// subtree ever becomes its own record.
//
// What's baked into the serialised markup (a data: URI can't see the page's
// own stylesheets, so anything CSS would have given it has to be inlined):
// - explicit width/height attributes = the element's local (untransformed)
//   layout size, so the rasteriser's intrinsic size matches what CSS gave it.
// - style="color: <computed color>" so descendant fill/stroke="currentColor"
//   resolve the same way they do on the live page.
// - fill/stroke attributes on the root, only when the computed value differs
//   from the SVG initial value (fill: black, stroke: none) — i.e. a
//   stylesheet rule, not an attribute already on the element, set them.
// - viewBox / preserveAspectRatio: copied as-is, for free, by cloneNode.
//
// Gap: an external `<use href="icons.svg#chevron">` can't resolve inside a
// data: URI (it would need a cross-document fetch); an inline `<use
// href="#id">` to a `<symbol>` in the SAME svg works, since cloneNode(true)
// carries the whole subtree into the serialised markup.

const SVG_NS = 'http://www.w3.org/2000/svg'
const DEFAULT_FILL = 'rgb(0, 0, 0)'
const DEFAULT_STROKE = 'none'
/** Bounded like imageRenderer's own rasterised-SVG cache (SVG_CACHE_LIMIT). */
const CACHE_LIMIT = 256

/** Is `el` an inline svg ROOT — an `<svg>` whose parent isn't SVG (the
 * outermost svg of an inline fragment, not a nested one under a
 * `<symbol>`/`<use>`, which paints as part of its own root's rasterisation)? */
export function isInlineSvgRoot(el: Element): el is SVGSVGElement {
  return el instanceof SVGSVGElement && el.ownerSVGElement === null
}

/** Fast non-cryptographic hash (FNV-1a) of a string, base36. Used as the
 * cache/image key for a serialised svg so identical icons (same markup,
 * same size) share one texture without comparing long data: URIs. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** Serialise `el` at `w`x`h` (local px), baking in what CSS would give it
 * (see file header) into a clone — the live element is never mutated. */
function serialize(
  el: SVGSVGElement,
  s: CSSStyleDeclaration,
  w: number,
  h: number
): string {
  const clone = el.cloneNode(true) as SVGSVGElement
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))
  clone.setAttribute('style', `color: ${s.color}`)
  if (s.fill && s.fill !== DEFAULT_FILL) {
    clone.setAttribute('fill', s.fill)
  }
  if (s.stroke && s.stroke !== DEFAULT_STROKE) {
    clone.setAttribute('stroke', s.stroke)
  }
  if (!clone.getAttribute('xmlns')) {
    clone.setAttribute('xmlns', SVG_NS)
  }
  return new XMLSerializer().serializeToString(clone)
}

interface Waiter {
  owner: object
  onReady: () => void
}

/** key -> the rasterised icon (loading, loaded or failed). Bounded: past
 * CACHE_LIMIT entries the whole cache is dropped rather than evicted one at
 * a time (mirrors imageRenderer's svgCache). */
const cache = new Map<string, HTMLImageElement>()
/** key -> callbacks to run when its image settles, one per waiting element.
 * Mirrors dom/backgrounds.ts's loadBackground/waiters — same shape, but
 * keyed by the FNV hash rather than the (much longer) data: URI itself,
 * since here the cache key and the URL to load aren't the same string. */
const waiters = new Map<string, Map<Element, Waiter>>()

function settle(key: string, loaded: boolean): void {
  const w = waiters.get(key)
  waiters.delete(key)
  if (!w || !loaded) {
    return
  }
  for (const { onReady } of w.values()) {
    onReady()
  }
}

/** Load (or return the already-loaded) rasterised icon for `key`/`dataUrl`,
 * registering `onReady` for (`owner`, `el`) while it decodes — same
 * loaded/pending/failed shape as dom/backgrounds.ts's loadBackground. */
function loadSvgImage(
  key: string,
  dataUrl: string,
  owner: object,
  el: Element,
  onReady: () => void
): HTMLImageElement | null {
  let img = cache.get(key)
  if (!img) {
    if (cache.size >= CACHE_LIMIT) {
      cache.clear()
    }
    img = new Image()
    img.addEventListener('load', () => settle(key, true), { once: true })
    img.addEventListener('error', () => settle(key, false), { once: true })
    img.src = dataUrl
    cache.set(key, img)
  }
  if (img.complete) {
    return img.naturalWidth > 0 ? img : null
  }
  let w = waiters.get(key)
  if (!w) {
    w = new Map()
    waiters.set(key, w)
  }
  w.set(el, { owner, onReady })
  return null
}

/** Drop every pending svg-image callback registered by `owner` (mirrors
 * disposeBackgrounds). */
export function disposeSvgImages(owner: object): void {
  for (const [key, w] of waiters) {
    for (const [el, waiter] of w) {
      if (waiter.owner === owner) {
        w.delete(el)
      }
    }
    if (w.size === 0) {
      waiters.delete(key)
    }
  }
}

/**
 * Build an ImageRecord for an inline svg root, or null when it isn't ready
 * to sample yet (rasterisation kicked off; `onReady` fires once it decodes)
 * or paints nothing (`visibility: hidden`, zero-size local box). `rect`/
 * `place` are the element's doc-space border box (AABB) and local
 * placement, as for `readImageRecord`. `owner`/`onReady` are as for
 * `loadBackground` (`owner` scopes disposal, `onReady` re-triggers a read).
 */
export function readSvgRecord(
  el: SVGSVGElement,
  s: CSSStyleDeclaration,
  rect: Rect,
  id: number,
  clip: Rect | null,
  place: Placement,
  owner: object,
  onReady: () => void
): ImageRecord | null {
  if (s.visibility !== 'visible') {
    return null
  }
  if (rect.width <= 0 || rect.height <= 0) {
    return null
  }
  const w = Math.max(1, place.local.w)
  const h = Math.max(1, place.local.h)
  const markup = serialize(el, s, w, h)
  const key = fnv1a(`${markup}|${w}x${h}`)
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
  const img = loadSvgImage(key, dataUrl, owner, el, onReady)
  if (!img) {
    return null
  }
  return {
    kind: 'image',
    id,
    rect,
    xform: place.xform,
    local: place.local,
    source: img,
    objectFit: 'fill',
    position: [0, 0],
    repeat: false,
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
