import type {
  BorderStyle,
  BoxRecord,
  Corners,
  Gradient,
  ImageRecord,
  Rect,
  RGBA,
  Space
} from '../scene/records'
import { parseColor } from '../util/color'
import { splitTopLevel } from '../util/css'
import { firstBackgroundLayer, parseGradient } from './gradient'
import { type Placement, placementAabb, subPlacement } from './transform'

// Scroll offset for the current read pass. `window.scrollX/Y` are native
// getters and were ~19% of a full read when called once per glyph; the reader
// snapshots them once per read (`beginRead`) since scroll can't change during
// the synchronous pass.
let readScrollX = 0
let readScrollY = 0
// Offset `toDocRect` adds: the scroll snapshot in document space, 0 while
// the reader walks a viewport-space (`position: fixed`) subtree.
let offX = 0
let offY = 0

/** Snapshot the scroll offset for `toDocRect`. Call at the start of a read.
 * Resets the read space to 'doc'. */
export function beginRead(): void {
  readScrollX = window.scrollX
  readScrollY = window.scrollY
  offX = readScrollX
  offY = readScrollY
}

/** Space `toDocRect` measures into until the next call (see records.ts). */
export function setReadSpace(space: Space): void {
  offX = space === 'viewport' ? 0 : readScrollX
  offY = space === 'viewport' ? 0 : readScrollY
}

/** Viewport-relative DOMRect -> the current read space: document space (CSS
 * px from doc top-left), or viewport space under setReadSpace('viewport'). */
export function toDocRect(r: DOMRect): Rect {
  return {
    x: r.left + offX,
    y: r.top + offY,
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
  if (token === 'center') {
    return 0.5
  }
  if (token === 'left' || token === 'top') {
    return 0
  }
  if (token === 'right' || token === 'bottom') {
    return 1
  }
  if (token.endsWith('%')) {
    const n = Number.parseFloat(token)
    return Number.isFinite(n) ? n / 100 : null
  }
  const n = Number.parseFloat(token)
  if (!Number.isFinite(n)) {
    return null
  }
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
  if (tokens.length < 2) {
    return fallback
  }
  const x = positionComponent(tokens[0] ?? '') ?? fallback[0]
  const y = positionComponent(tokens[1] ?? '') ?? fallback[1]
  return [x, y]
}

/** The element's own computed opacity, defaulting to 1. */
export function readOpacity(s: CSSStyleDeclaration): number {
  const n = Number.parseFloat(s.opacity)
  return Number.isFinite(n) ? n : 1
}

/**
 * Build a BoxRecord for an element's background + border, or null when it
 * paints nothing we care about. Radii/border are read from computed style;
 * `rect` is the element's doc-space border box (its AABB when transformed),
 * read once by the caller; `place` is its local box (see transform.ts) —
 * radii and gradients resolve against the local (untransformed) size.
 * `opacity` is 1 (element opacity is applied by its opacity group, see
 * stacking.ts); `z` is a placeholder the stacking pass overwrites.
 */
export function readBox(
  s: CSSStyleDeclaration,
  rect: Rect,
  id: number,
  place: Placement
): BoxRecord | null {
  if (s.visibility !== 'visible' || s.display === 'none') {
    return null
  }

  const fill = parseColor(s.backgroundColor)
  const border = readBorder(s)
  const hasFill = fill.a > 0.001
  if (rect.width <= 0 || rect.height <= 0) {
    return null
  }

  // First background-image layer, when it is a gradient (url() layers are
  // image records, handled elsewhere). Resolved against the padding box
  // (background-origin: padding-box), inset per side by the border widths
  // the shader uses, so the two agree.
  const lw = place.local.w
  const lh = place.local.h
  const localRect = { x: 0, y: 0, width: lw, height: lh }
  let gradient: Gradient | null = null
  const bgi = s.backgroundImage
  if (bgi && bgi !== 'none') {
    const layer = firstBackgroundLayer(bgi)
    if (layer && !layer.startsWith('url(')) {
      const [bt, br, bb, bl] = border ? border.widths : [0, 0, 0, 0]
      gradient = parseGradient(layer, {
        x: bl,
        y: bt,
        width: Math.max(0, lw - bl - br),
        height: Math.max(0, lh - bt - bb)
      })
    }
  }
  if (!hasFill && !border && !gradient) {
    return null
  }

  return {
    kind: 'box',
    id,
    rect,
    xform: place.xform,
    local: place.local,
    radius: readCorners(s, localRect),
    fill,
    gradient,
    border,
    opacity: 1,
    z: 0
  }
}

const NO_BORDER_STYLE = new Set(['none', 'hidden'])
const BORDER_STYLE_CODE: Record<string, BorderStyle> = {
  dashed: 1,
  dotted: 2,
  double: 3
}

/**
 * The four border sides, [top, right, bottom, left], or null when none
 * paints. `none`/`hidden` zero a side's width; a transparent side keeps
 * its width (it still insets the padding box) but paints nothing.
 * dashed/dotted/double carry their style code; groove/ridge/inset/outset
 * draw solid.
 */
function readBorder(s: CSSStyleDeclaration): BoxRecord['border'] {
  const side = (width: string, style: string) =>
    NO_BORDER_STYLE.has(style) ? 0 : px(width)
  const widths: [number, number, number, number] = [
    side(s.borderTopWidth, s.borderTopStyle),
    side(s.borderRightWidth, s.borderRightStyle),
    side(s.borderBottomWidth, s.borderBottomStyle),
    side(s.borderLeftWidth, s.borderLeftStyle)
  ]
  const colors: [RGBA, RGBA, RGBA, RGBA] = [
    parseColor(s.borderTopColor),
    parseColor(s.borderRightColor),
    parseColor(s.borderBottomColor),
    parseColor(s.borderLeftColor)
  ]
  const styles: [BorderStyle, BorderStyle, BorderStyle, BorderStyle] = [
    BORDER_STYLE_CODE[s.borderTopStyle] ?? 0,
    BORDER_STYLE_CODE[s.borderRightStyle] ?? 0,
    BORDER_STYLE_CODE[s.borderBottomStyle] ?? 0,
    BORDER_STYLE_CODE[s.borderLeftStyle] ?? 0
  ]
  const paints = widths.some((w, i) => w > 0 && (colors[i]?.a ?? 0) > 0.001)
  return paints ? { widths, colors, styles } : null
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

const EMPTY_SVG = /<svg[^>]*>\s*<\/svg>/i

/**
 * True for a `data:image/svg+xml` URI whose markup has no drawing elements —
 * just an empty `<svg>` root (gatsby-plugin-image's transparent sizer image,
 * emitted at natural sizes like 2560x2560 that would otherwise be rasterised
 * for nothing). Any other SVG, and any non-svg/non-data URI, is false.
 */
export function isEmptySvgDataUri(src: string): boolean {
  const m =
    /^data:image\/svg\+xml(?:;charset=[^;,]*)?(;base64)?,([\s\S]*)$/i.exec(src)
  if (!m) {
    return false
  }
  let markup: string
  try {
    markup = m[1] ? atob(m[2] as string) : decodeURIComponent(m[2] as string)
  } catch {
    return false
  }
  return EMPTY_SVG.test(markup)
}

/**
 * Build an ImageRecord for a replaced element (<img>, <canvas>, <video>), or
 * null when it isn't ready to sample. Canvas and video are marked dynamic so
 * their textures re-upload every frame. `rect` is the element's doc-space
 * border box (AABB) and `place` its local box. `opacity` and `z` are as
 * in readBox.
 */
export function readImageRecord(
  el: Element,
  s: CSSStyleDeclaration,
  rect: Rect,
  id: number,
  clip: Rect | null,
  place: Placement
): ImageRecord | null {
  if (s.visibility !== 'visible') {
    return null
  }
  let source: CanvasImageSource
  let dynamic = false
  if (el.tagName === 'IMG') {
    const img = el as HTMLImageElement
    if (!img.complete || img.naturalWidth === 0) {
      return null
    }
    if (isEmptySvgDataUri(img.currentSrc || img.src)) {
      // gatsby-plugin-image's transparent sizer: `<svg ...></svg>` with no
      // drawing elements at all — fully transparent, nothing to paint.
      return null
    }
    source = img
  } else if (el.tagName === 'VIDEO') {
    const v = el as HTMLVideoElement
    if (v.readyState < 2 || v.videoWidth === 0) {
      return null
    }
    source = v
    dynamic = true
  } else if (el.tagName === 'CANVAS') {
    const c = el as HTMLCanvasElement
    if (c.width === 0 || c.height === 0) {
      return null
    }
    source = c
    dynamic = true
  } else {
    return null
  }
  if (rect.width <= 0 || rect.height <= 0) {
    return null
  }
  const of = s.objectFit
  return {
    kind: 'image',
    id,
    rect,
    xform: place.xform,
    local: place.local,
    source,
    objectFit: of === 'cover' ? 'cover' : of === 'contain' ? 'contain' : 'fill',
    position: mapBackgroundPosition(s.objectPosition || '50% 50%', [0.5, 0.5]),
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
    dynamic
  }
}

/**
 * Padding (local px) a shadow record adds around its shadow box so the
 * Gaussian has room: 3σ with σ = blur / 2 (CSS: the blur radius is 2σ).
 * The box pass reads the same function when packing the instance.
 */
export function shadowPad(blur: number): number {
  return Math.ceil(1.5 * Math.max(0, blur))
}

const LENGTH = /^-?(\d+\.?\d*|\.\d+)(e-?\d+)?(px)?$/i

interface ShadowLayer {
  color: string
  ox: number
  oy: number
  blur: number
  spread: number
  inset: boolean
}

/** One computed `box-shadow` layer, or null for unparsable ones. */
function parseShadowLayer(layer: string): ShadowLayer | null {
  const lens: number[] = []
  let color = ''
  let inset = false
  for (const tok of splitTopLevel(layer, ' ')) {
    if (!tok) {
      continue
    }
    if (tok === 'inset') {
      inset = true
    } else if (LENGTH.test(tok)) {
      lens.push(Number.parseFloat(tok))
    } else {
      color = tok
    }
  }
  if (lens.length < 2) {
    return null
  }
  return {
    color,
    ox: lens[0] ?? 0,
    oy: lens[1] ?? 0,
    blur: Math.max(0, lens[2] ?? 0),
    spread: lens[3] ?? 0,
    inset
  }
}

/** CSS corner clamp (see readCorners) for an arbitrary w × h box. */
function clampCorners(r: Corners, w: number, h: number): Corners {
  const [tl, tr, br, bl] = r
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

/**
 * One BoxRecord per outer `box-shadow` layer, in paint order (CSS paints
 * the last layer bottom-most, so the list is reversed). Each record's local
 * box is the shadow box (border box offset by (ox, oy), grown by `spread`)
 * padded by `shadowPad(blur)` on every side; `radius` is the shadow box's
 * radii (`r + spread` for r > 0 — the CSS small-radius attenuation is
 * ignored), `shadow.inner` the element's border box in the record's local
 * frame. `rect`/`place` are the element's doc-space border box and
 * placement; `alloc` hands out ids.
 *
 * With `inset` set it returns the inset layers instead (also last-listed
 * first), which paint above the background: each record's box is the
 * padding box (radii `r - border`), `shadow.inner` the shadow box (padding
 * box offset by (ox, oy), shrunk by `spread`, radii `r - spread`).
 */
export function readShadows(
  s: CSSStyleDeclaration,
  rect: Rect,
  place: Placement,
  alloc: () => number,
  inset = false
): BoxRecord[] {
  const value = s.boxShadow
  if (!value || value === 'none') {
    return []
  }
  if (s.visibility !== 'visible' || s.display === 'none') {
    return []
  }
  if (rect.width <= 0 || rect.height <= 0) {
    return []
  }
  const { w, h } = place.local
  const radius = readCorners(s, { x: 0, y: 0, width: w, height: h })
  const out: BoxRecord[] = []
  const layers = splitTopLevel(value, ',').filter(Boolean)
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = parseShadowLayer(layers[i] ?? '')
    if (!layer || layer.inset !== inset) {
      continue
    }
    const color = parseColor(layer.color || s.color)
    if (color.a <= 0.001) {
      continue
    }
    if (inset) {
      const rec = insetShadow(s, place, radius, layer, color, alloc())
      if (rec) {
        out.push(rec)
      }
      continue
    }
    const { ox, oy, blur, spread } = layer
    const sw = w + 2 * spread
    const sh = h + 2 * spread
    if (sw <= 0 || sh <= 0) {
      continue
    }
    const pad = shadowPad(blur)
    const x0 = ox - spread - pad
    const y0 = oy - spread - pad
    const sp = subPlacement(place, x0, y0, sw + 2 * pad, sh + 2 * pad)
    const grown = radius.map((r) =>
      r > 0 ? Math.max(0, r + spread) : 0
    ) as Corners
    // Batching footprint: 1.5σ (vs. the 3σ paint padding above) — the tail
    // beyond it is under ~7% alpha, so using it for overlap tests keeps
    // adjacent elements' shadows from splitting batches without visibly
    // reordering paint.
    const batchPad = Math.ceil(0.75 * blur)
    const bx0 = ox - spread - batchPad
    const by0 = oy - spread - batchPad
    const batchSp = subPlacement(
      place,
      bx0,
      by0,
      sw + 2 * batchPad,
      sh + 2 * batchPad
    )
    out.push({
      kind: 'box',
      id: alloc(),
      rect: placementAabb(sp),
      xform: sp.xform,
      local: sp.local,
      radius: clampCorners(grown, sw, sh),
      fill: color,
      gradient: null,
      border: null,
      shadow: {
        color,
        blur,
        inner: { x: -x0, y: -y0, w, h, radius }
      },
      opacity: 1,
      z: 0,
      batchRect: placementAabb(batchSp)
    })
  }
  return out
}

/** One inset layer as a BoxRecord over the padding box (see readShadows). */
function insetShadow(
  s: CSSStyleDeclaration,
  place: Placement,
  radius: Corners,
  layer: ShadowLayer,
  color: RGBA,
  id: number
): BoxRecord | null {
  const bl = px(s.borderLeftWidth)
  const bt = px(s.borderTopWidth)
  const br = px(s.borderRightWidth)
  const bb = px(s.borderBottomWidth)
  const pw = place.local.w - bl - br
  const ph = place.local.h - bt - bb
  if (pw <= 0 || ph <= 0) {
    return null
  }
  const { ox, oy, blur, spread } = layer
  const [tl, tr, brr, bll] = radius
  const pr: Corners = [
    Math.max(0, tl - Math.max(bl, bt)),
    Math.max(0, tr - Math.max(br, bt)),
    Math.max(0, brr - Math.max(br, bb)),
    Math.max(0, bll - Math.max(bl, bb))
  ]
  const sw = Math.max(0, pw - 2 * spread)
  const sh = Math.max(0, ph - 2 * spread)
  const shrunk = pr.map((r) => (r > 0 ? Math.max(0, r - spread) : 0))
  const sp = subPlacement(place, bl, bt, pw, ph)
  return {
    kind: 'box',
    id,
    rect: placementAabb(sp),
    xform: sp.xform,
    local: sp.local,
    radius: pr,
    fill: color,
    gradient: null,
    border: null,
    shadow: {
      color,
      blur,
      inner: {
        x: ox + spread,
        y: oy + spread,
        w: sw,
        h: sh,
        radius: clampCorners(shrunk as Corners, sw, sh)
      },
      inset: true
    },
    opacity: 1,
    z: 0
  }
}
