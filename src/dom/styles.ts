import type {
  BoxRecord,
  Corners,
  Gradient,
  ImageRecord,
  Rect
} from '../scene/records'
import { parseColor } from '../util/color'
import { firstBackgroundLayer, parseGradient } from './gradient'

/** Viewport-relative DOMRect -> document space (CSS px from doc top-left). */
export function toDocRect(r: DOMRect): Rect {
  return {
    x: r.left + window.scrollX,
    y: r.top + window.scrollY,
    width: r.width,
    height: r.height
  }
}

export function px(v: string): number {
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

/** One `border-*-radius` longhand -> its horizontal (first) value in px.
 * The computed value can be two lengths (`10px 20px`, an elliptical
 * corner) — only the first (horizontal) one is used, an approximation.
 * `%` resolves against `min(rect.width, rect.height)`, also an
 * approximation of the per-axis CSS rule (horizontal % of width, vertical
 * % of height). */
function cornerRadius(value: string, rect: Rect): number {
  const first = value.trim().split(/\s+/)[0] ?? ''
  if (first.endsWith('%')) {
    const n = Number.parseFloat(first)
    return Number.isFinite(n)
      ? (n / 100) * Math.min(rect.width, rect.height)
      : 0
  }
  return px(first)
}

/**
 * Border radii for `rect`, CSS-clamped so adjacent corners never overlap:
 * scale all four by `f = min(1, w/(tl+tr), w/(bl+br), h/(tl+bl), h/(tr+br))`.
 * Without this an oversized radius (e.g. a `999px` pill) makes every
 * fragment fail the rounded-box SDF and the box vanishes entirely.
 */
export function readCorners(s: CSSStyleDeclaration, rect: Rect): Corners {
  const tl = cornerRadius(s.borderTopLeftRadius, rect)
  const tr = cornerRadius(s.borderTopRightRadius, rect)
  const br = cornerRadius(s.borderBottomRightRadius, rect)
  const bl = cornerRadius(s.borderBottomLeftRadius, rect)
  const { width: w, height: h } = rect
  const ratio = (sum: number, dim: number) => (sum > 0 ? dim / sum : 1)
  const f = Math.min(
    1,
    ratio(tl + tr, w),
    ratio(bl + br, w),
    ratio(tl + bl, h),
    ratio(tr + br, h)
  )
  return [tl * f, tr * f, br * f, bl * f]
}

/** One `object-position` / `background-position` component -> a 0..1
 * fraction of the free space. Percentages map directly; keywords resolve
 * to their CSS fraction; a length (px etc.) can't be turned into a
 * fraction without knowing the free space here, so it's clamped to 0 or 1
 * by sign (an approximation). */
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

/** `object-position` / `background-position` -> [x, y] fractions.
 * `fallback` is returned whenever it can't be parsed (fewer than two
 * tokens): [0.5, 0.5] for `object-position`, [0, 0] for
 * `background-position`. */
export function mapBackgroundPosition(
  position: string,
  fallback: [number, number] = [0, 0]
): [number, number] {
  const tokens = position.trim().split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return fallback
  const x = positionComponent(tokens[0] ?? '') ?? fallback[0]
  const y = positionComponent(tokens[1] ?? '') ?? fallback[1]
  return [x, y]
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
  if (rect.width <= 0 || rect.height <= 0) return null

  // First background-image layer, when it is a gradient (url() layers are
  // image records, handled elsewhere). Resolved against the padding box
  // (background-origin: padding-box), inset by the same uniform border width
  // the shader uses, so the two agree.
  let gradient: Gradient | null = null
  const bgi = s.backgroundImage
  if (bgi && bgi !== 'none') {
    const layer = firstBackgroundLayer(bgi)
    if (layer && !layer.startsWith('url(')) {
      const inset = hasBorder ? borderWidth : 0
      gradient = parseGradient(layer, {
        x: rect.x + inset,
        y: rect.y + inset,
        width: Math.max(0, rect.width - 2 * inset),
        height: Math.max(0, rect.height - 2 * inset)
      })
    }
  }
  if (!hasFill && !hasBorder && !gradient) return null

  return {
    kind: 'box',
    id,
    rect,
    radius: readCorners(s, rect),
    fill,
    gradient,
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
    position: mapBackgroundPosition(s.objectPosition || '50% 50%', [0.5, 0.5]),
    repeat: false,
    radius: readCorners(s, rect),
    opacity: 1,
    z: 0,
    clip,
    dynamic
  }
}
