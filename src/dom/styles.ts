import type { BoxRecord, Corners, Rect } from '../scene/records'
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
