import type { ImageRecord } from '../scene/records'

// SVG <img> / background sources: what the browser sizes them by, and the
// markup to rasterise them at a given size. Canvas drawImage() renders an
// SVG at its natural size and then scales the bitmap, and an SVG with no
// width/height reports Chrome's default 300×150 as its natural size, so a
// viewBox-only SVG drawn straight to a canvas comes out stretched. The
// browser instead renders it at its CSS concrete object size, letting the
// SVG's own preserveAspectRatio place the content. For `data:` URIs we
// can do the same: parse the markup, take the intrinsic ratio from
// width/height/viewBox, and re-serialise it with width/height set to the
// raster size.

export interface SvgIntrinsic {
  /** Intrinsic size in CSS px, when the root has absolute width/height. */
  w: number | null
  h: number | null
  /** Intrinsic aspect ratio (w / h), from width/height or the viewBox. */
  ratio: number | null
  /** Parsed root (data: URIs, and URL sources once their markup is
   * fetched), for re-serialising at a size. */
  root: SVGSVGElement | null
  /** The root sets both width and height (its natural size is real). */
  explicit: boolean
}

const CACHE_LIMIT = 64
const cache = new Map<string, SvgIntrinsic>()
/** URL (non-`data:`) sources' markup, fetched once: the text, null when
 * the fetch failed (CORS, network), 'pending' while it runs. */
const fetched = new Map<string, string | null | 'pending'>()

/**
 * Fetch the markup of a URL SVG source once, so svgIntrinsic can parse it
 * like a `data:` one (its natural size otherwise defaults to 300×150).
 * `onDone` runs when markup arrives (not on failure).
 */
export function requestSvgMarkup(src: string, onDone: () => void): void {
  if (src.startsWith('data:')) {
    return
  }
  if (fetched.has(src)) {
    const w = waiting.get(src)
    w?.add(onDone)
    return
  }
  // Same-origin only (a cross-origin fetch without CORS, or one a CSP
  // blocks, logs an error the page can't catch), and not a fragment
  // (`sprite.svg#icon`: fetch drops it and would raster the whole file).
  let url: URL
  try {
    url = new URL(src, location.href)
  } catch {
    fetched.set(src, null)
    return
  }
  if (url.origin !== location.origin || url.hash) {
    fetched.set(src, null)
    return
  }
  fetched.set(src, 'pending')
  waiting.set(src, new Set([onDone]))
  fetch(url)
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null)
    .then((text) => {
      fetched.set(src, text)
      const w = waiting.get(src)
      waiting.delete(src)
      if (text) {
        cache.delete(src)
        for (const cb of w ?? []) {
          cb()
        }
      }
    })
}

/** Callbacks for a markup fetch still running. */
const waiting = new Map<string, Set<() => void>>()

function absLength(v: string | null): number | null {
  if (!v) {
    return null
  }
  const m = /^\s*([\d.]+)\s*(px)?\s*$/.exec(v)
  const n = m?.[1] ? Number.parseFloat(m[1]) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

function decodeDataUri(src: string): string | null {
  const comma = src.indexOf(',')
  if (comma < 0) {
    return null
  }
  const head = src.slice(0, comma)
  const body = src.slice(comma + 1)
  try {
    return /;base64/i.test(head) ? atob(body) : decodeURIComponent(body)
  } catch {
    return null
  }
}

/** Intrinsic size/ratio of the SVG `img` shows (cached by source). */
export function svgIntrinsic(img: HTMLImageElement, src: string): SvgIntrinsic {
  const hit = cache.get(src)
  if (hit) {
    return hit
  }
  let out: SvgIntrinsic = {
    w: img.naturalWidth || null,
    h: img.naturalHeight || null,
    ratio:
      img.naturalWidth && img.naturalHeight
        ? img.naturalWidth / img.naturalHeight
        : null,
    root: null,
    explicit: true
  }
  const got = fetched.get(src)
  const remote = typeof got === 'string' && got !== 'pending' ? got : null
  if (src.startsWith('data:') || remote) {
    const text = remote ?? decodeDataUri(src)
    const doc = text
      ? new DOMParser().parseFromString(text, 'image/svg+xml')
      : null
    const root = doc?.documentElement
    if (root instanceof SVGSVGElement && !doc?.querySelector('parsererror')) {
      const w = absLength(root.getAttribute('width'))
      const h = absLength(root.getAttribute('height'))
      const vb = (root.getAttribute('viewBox') ?? '')
        .trim()
        .split(/[\s,]+/)
        .map(Number)
      const vbw = vb[2] ?? 0
      const vbh = vb[3] ?? 0
      const vbRatio = vb.length === 4 && vbw > 0 && vbh > 0 ? vbw / vbh : null
      const ratio = w && h ? w / h : vbRatio
      out = {
        w: w ?? (h && ratio ? h * ratio : null),
        h: h ?? (w && ratio ? w / ratio : null),
        ratio,
        root,
        explicit: w !== null && h !== null
      }
    }
  }
  if (cache.size >= CACHE_LIMIT) {
    cache.clear()
  }
  cache.set(src, out)
  return out
}

/**
 * CSS concrete object size (CSS px) of an SVG with `intr` placed by `fit`
 * in a `w`×`h` box (object-fit for <img>, the background-size mapping for
 * backgrounds). The browser renders the SVG at this size.
 */
export function concreteSize(
  fit: ImageRecord['objectFit'],
  w: number,
  h: number,
  intr: SvgIntrinsic
): { w: number; h: number } {
  const r = intr.ratio
  if (fit === 'fill' || (!r && fit !== 'none')) {
    return { w, h }
  }
  if (fit === 'none') {
    if (intr.w && intr.h) {
      return { w: intr.w, h: intr.h }
    }
    // No intrinsic size: the default object size, 300×150, fitted to the
    // ratio when there is one.
    if (!r) {
      return { w: 300, h: 150 }
    }
    return r > 2 ? { w: 300, h: 300 / r } : { w: 150 * r, h: 150 }
  }
  const box = w / Math.max(h, 1e-6)
  const ratio = r ?? box
  const widthBound = fit === 'contain' ? box <= ratio : box > ratio
  return widthBound ? { w, h: w / ratio } : { w: h * ratio, h }
}

/**
 * The SVG markup re-sized to `w`×`h` px, or null when drawing the element
 * scaled is already right: it isn't parsed, or it has a real natural size
 * with the raster's aspect ratio (the browser then renders it at exactly
 * that scale). A root with width/height but no viewBox gets one, so it
 * scales, not crops.
 */
export function sizedMarkup(
  intr: SvgIntrinsic,
  w: number,
  h: number
): string | null {
  const root = intr.root
  if (!root) {
    return null
  }
  if (
    intr.explicit &&
    intr.ratio &&
    Math.abs(w / Math.max(h, 1e-6) - intr.ratio) <= intr.ratio * 0.01
  ) {
    return null
  }
  const el = root.cloneNode(true) as SVGSVGElement
  if (!el.hasAttribute('viewBox') && intr.w && intr.h) {
    el.setAttribute('viewBox', `0 0 ${intr.w} ${intr.h}`)
  }
  el.setAttribute('width', String(w))
  el.setAttribute('height', String(h))
  return new XMLSerializer().serializeToString(el)
}
