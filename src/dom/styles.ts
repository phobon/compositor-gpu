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

/** Own (not effective/ancestor-multiplied) opacity, defaulting to 1. */
export function readOpacity(s: CSSStyleDeclaration): number {
  const n = Number.parseFloat(s.opacity)
  return Number.isFinite(n) ? n : 1
}

/**
 * Build a BoxRecord for an element's background + border, or null when it
 * paints nothing we care about. Radii/border are read from computed style;
 * `rect` is the element's doc-space border box, read once by the caller.
 * `opacity` and `z` are placeholders the reader overwrites (effective
 * opacity and global paint order aren't known until the stacking pass).
 */
export function readBox(
  s: CSSStyleDeclaration,
  rect: Rect,
  id: number
): BoxRecord | null {
  if (s.visibility === 'hidden' || s.display === 'none') return null

  const fill = parseColor(s.backgroundColor)
  const borderWidth = px(s.borderTopWidth)
  const borderColor = parseColor(s.borderTopColor)
  const hasFill = fill.a > 0.001
  const hasBorder = borderWidth > 0 && borderColor.a > 0.001
  if (!hasFill && !hasBorder) return null
  if (rect.width <= 0 || rect.height <= 0) return null

  return {
    kind: 'box',
    id,
    rect,
    radius: readCorners(s),
    fill,
    border: hasBorder ? { width: borderWidth, color: borderColor } : null,
    opacity: 1,
    z: 0
  }
}

const CLIP_OVERFLOW = new Set(['hidden', 'scroll', 'auto', 'clip'])

/**
 * The padding-box clip rect (document space) an element imposes on its content
 * when it clips overflow, or null when overflow is visible. `r` is the
 * element's doc-space border box.
 */
export function clipRectFor(s: CSSStyleDeclaration, r: Rect): Rect | null {
  if (!CLIP_OVERFLOW.has(s.overflowX) && !CLIP_OVERFLOW.has(s.overflowY)) {
    return null
  }
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
 * their textures re-upload every frame. `rect` is the element's doc-space
 * border box. `opacity` and `z` are placeholders the reader overwrites, as
 * in readBox.
 */
export function readImageRecord(
  el: Element,
  s: CSSStyleDeclaration,
  rect: Rect,
  id: number,
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
  if (rect.width <= 0 || rect.height <= 0) return null
  const of = s.objectFit
  return {
    kind: 'image',
    id,
    rect,
    source,
    objectFit: of === 'cover' ? 'cover' : of === 'contain' ? 'contain' : 'fill',
    opacity: 1,
    z: 0,
    clip,
    dynamic
  }
}
