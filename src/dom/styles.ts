import type { BoxRecord, Corners, ImageRecord, Rect } from '../scene/records'
import { parseColor } from '../util/color'

/** Viewport-relative DOMRect -> document space (CSS px from doc top-left). */
export function toDocRect(r: DOMRect): Rect {
  return {
    x: r.left + window.scrollX,
    y: r.top + window.scrollY,
    width: r.width,
    height: r.height
  }
}

function px(v: string): number {
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

function readCorners(s: CSSStyleDeclaration): Corners {
  return [
    px(s.borderTopLeftRadius),
    px(s.borderTopRightRadius),
    px(s.borderBottomRightRadius),
    px(s.borderBottomLeftRadius)
  ]
}

/**
 * Build a BoxRecord for an element's background + border, or null when it
 * paints nothing we care about. Radii/border are read from computed style.
 */
export function readBox(el: Element, id: number, z: number): BoxRecord | null {
  const s = getComputedStyle(el)
  if (s.visibility === 'hidden' || s.display === 'none') return null

  const fill = parseColor(s.backgroundColor)
  const borderWidth = px(s.borderTopWidth)
  const borderColor = parseColor(s.borderTopColor)
  const hasFill = fill.a > 0.001
  const hasBorder = borderWidth > 0 && borderColor.a > 0.001
  if (!hasFill && !hasBorder) return null

  const rect = toDocRect(el.getBoundingClientRect())
  if (rect.width <= 0 || rect.height <= 0) return null

  return {
    kind: 'box',
    id,
    rect,
    radius: readCorners(s),
    fill,
    border: hasBorder ? { width: borderWidth, color: borderColor } : null,
    opacity: px(s.opacity || '1') || 1,
    z
  }
}

const CLIP_OVERFLOW = new Set(['hidden', 'scroll', 'auto', 'clip'])

/**
 * The padding-box clip rect (document space) an element imposes on its content
 * when it clips overflow, or null when overflow is visible.
 */
export function clipRectFor(el: Element): Rect | null {
  const s = getComputedStyle(el)
  if (!CLIP_OVERFLOW.has(s.overflowX) && !CLIP_OVERFLOW.has(s.overflowY)) {
    return null
  }
  const r = toDocRect(el.getBoundingClientRect())
  const bl = px(s.borderLeftWidth)
  const bt = px(s.borderTopWidth)
  const br = px(s.borderRightWidth)
  const bb = px(s.borderBottomWidth)
  return {
    x: r.x + bl,
    y: r.y + bt,
    width: Math.max(0, r.width - bl - br),
    height: Math.max(0, r.height - bt - bb)
  }
}

/**
 * Build an ImageRecord for a replaced element (<img>, <canvas>, <video>), or
 * null when it isn't ready to sample. Canvas and video are marked dynamic so
 * their textures re-upload every frame.
 */
export function readImageRecord(
  el: Element,
  id: number,
  z: number,
  clip: Rect | null
): ImageRecord | null {
  let source: CanvasImageSource
  let dynamic = false
  if (el.tagName === 'IMG') {
    const img = el as HTMLImageElement
    if (!img.complete || img.naturalWidth === 0) return null
    source = img
  } else if (el.tagName === 'VIDEO') {
    const v = el as HTMLVideoElement
    if (v.readyState < 2 || v.videoWidth === 0) return null
    source = v
    dynamic = true
  } else if (el.tagName === 'CANVAS') {
    const c = el as HTMLCanvasElement
    if (c.width === 0 || c.height === 0) return null
    source = c
    dynamic = true
  } else {
    return null
  }
  const rect = toDocRect(el.getBoundingClientRect())
  if (rect.width <= 0 || rect.height <= 0) return null
  const of = getComputedStyle(el).objectFit
  return {
    kind: 'image',
    id,
    rect,
    source,
    objectFit: of === 'cover' ? 'cover' : of === 'contain' ? 'contain' : 'fill',
    opacity: 1,
    z: z + 0.5,
    clip,
    dynamic
  }
}
