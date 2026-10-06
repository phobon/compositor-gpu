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
import { backgroundLayers, parseGradient } from './gradient'
import { HIDDEN_ATTR } from './observer'
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

/** One `border-*-radius` longhand -> [horizontal, vertical] px. The
 * computed value is one length or two (`10px 20px`, an elliptical
 * corner); `%` resolves against the width (horizontal) and the height
 * (vertical). */
function cornerRadius(value: string, rect: Rect): [number, number] {
  const parts = value.trim().split(/\s+/)
  const h = parts[0] ?? ''
  const v = parts[1] ?? h
  const len = (tok: string, dim: number): number => {
    if (tok.endsWith('%')) {
      const n = Number.parseFloat(tok)
      return Number.isFinite(n) ? (n / 100) * dim : 0
    }
    return px(tok)
  }
  return [len(h, rect.width), len(v, rect.height)]
}

/**
 * Horizontal and vertical border radii for `rect`, CSS-clamped so
 * adjacent corners never overlap: both scaled by `f = min(1, w/(tl+tr),
 * w/(bl+br), h/(tl+bl), h/(tr+br))`, horizontal radii against the width
 * and vertical ones against the height. Without this an oversized radius
 * (e.g. a `999px` pill) makes every fragment fail the rounded-box SDF and
 * the box vanishes entirely.
 */
export function readCornerRadii(
  s: CSSStyleDeclaration,
  rect: Rect
): { x: Corners; y: Corners } {
  const tl = cornerRadius(s.borderTopLeftRadius, rect)
  const tr = cornerRadius(s.borderTopRightRadius, rect)
  const br = cornerRadius(s.borderBottomRightRadius, rect)
  const bl = cornerRadius(s.borderBottomLeftRadius, rect)
  const { width: w, height: h } = rect
  const ratio = (sum: number, dim: number) => (sum > 0 ? dim / sum : 1)
  const f = Math.min(
    1,
    ratio(tl[0] + tr[0], w),
    ratio(bl[0] + br[0], w),
    ratio(tl[1] + bl[1], h),
    ratio(tr[1] + br[1], h)
  )
  return {
    x: [tl[0] * f, tr[0] * f, br[0] * f, bl[0] * f],
    y: [tl[1] * f, tr[1] * f, br[1] * f, bl[1] * f]
  }
}

/**
 * Circular border radii for `rect`: per corner the smaller of its two
 * clamped radii (an elliptical corner drawn circular). For the records
 * that carry no `radiusY` (shadows, outlines, background images).
 */
export function readCorners(s: CSSStyleDeclaration, rect: Rect): Corners {
  const { x, y } = readCornerRadii(s, rect)
  return [
    Math.min(x[0], y[0]),
    Math.min(x[1], y[1]),
    Math.min(x[2], y[2]),
    Math.min(x[3], y[3])
  ]
}

/** `radius` + `radiusY` for a record: `radiusY` only when elliptical. */
export function recordRadii(
  s: CSSStyleDeclaration,
  rect: Rect
): { radius: Corners; radiusY?: Corners } {
  const { x, y } = readCornerRadii(s, rect)
  return x.every((v, i) => v === y[i])
    ? { radius: x }
    : { radius: x, radiusY: y }
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

/** The element's own computed opacity, defaulting to 1. An element that
 * replace mode hid (`HIDDEN_ATTR`) reports the opacity it had before. */
export function readOpacity(s: CSSStyleDeclaration, el?: Element): number {
  const saved = el?.getAttribute(HIDDEN_ATTR)
  const n = Number.parseFloat(saved ?? s.opacity)
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

  // The bottom background-image layer, when it is a gradient, paints in
  // this record over the colour; the layers above it are records of their
  // own (backgroundLayerRecords in tree.ts).
  const lw = place.local.w
  const lh = place.local.h
  const localRect = { x: 0, y: 0, width: lw, height: lh }
  const layers = backgroundLayers(s.backgroundImage)
  const gradient =
    layers.length > 0
      ? layerGradient(s, layers, layers.length - 1, border, lw, lh)
      : null
  if (!hasFill && !border && !gradient) {
    return null
  }
  const bgInset = readBgInset(s)

  return {
    kind: 'box',
    id,
    rect,
    xform: place.xform,
    local: place.local,
    ...recordRadii(s, localRect),
    fill,
    gradient,
    ...(bgInset ? { bgInset } : {}),
    border,
    opacity: 1,
    z: 0
  }
}

/**
 * Background layer `i` (of `layers`, top-most first) as a gradient, or
 * null when it is a url(), unsupported or sized to nothing. Positioned in
 * the `background-origin` box, placed from the padding box (inset per
 * side by the border widths the shader uses, so the two agree); `repeat`
 * per axis from the layer's background-repeat.
 */
export function layerGradient(
  s: CSSStyleDeclaration,
  layers: readonly string[],
  i: number,
  border: BoxRecord['border'],
  lw: number,
  lh: number
): Gradient | null {
  const layer = layers[i]
  if (!layer || layer === 'none' || layer.startsWith('url(')) {
    return null
  }
  const [bt, br, bb, bl] = border ? border.widths : [0, 0, 0, 0]
  const pw = Math.max(0, lw - bl - br)
  const ph = Math.max(0, lh - bt - bb)
  const pick = (list: string, fallback: string): string => {
    const parts = splitTopLevel(list, ',')
    return (parts[i % Math.max(1, parts.length)] ?? '').trim() || fallback
  }
  // The origin box relative to the padding box.
  const oi = boxInset(s, pick(s.backgroundOrigin, 'padding-box'))
  const pi = boxInset(s, 'padding-box')
  const ox = oi[3] - pi[3]
  const oy = oi[0] - pi[0]
  const ow = Math.max(0, pw - ox - (oi[1] - pi[1]))
  const oh = Math.max(0, ph - oy - (oi[2] - pi[2]))
  // background-size / -position: a gradient has no intrinsic size, so
  // auto, cover and contain fill the area (the origin box).
  const size = backgroundSize(pick(s.backgroundSize, 'auto'), ow, oh)
  const tw = size?.[0] ?? ow
  const th = size?.[1] ?? oh
  if (tw <= 0 || th <= 0) {
    return null
  }
  const [px0, py0] = positionPx(
    pick(s.backgroundPosition, '0% 0%'),
    ow - tw,
    oh - th
  )
  const tx = ox + px0
  const ty = oy + py0
  const tiled = tw !== pw || th !== ph || tx !== 0 || ty !== 0
  const gradient = parseGradient(
    layer,
    tiled
      ? { x: 0, y: 0, width: tw, height: th }
      : { x: bl, y: bt, width: pw, height: ph }
  )
  if (gradient && tiled) {
    gradient.tile = [tx, ty, tw, th]
  }
  if (gradient) {
    gradient.repeat = repeatAxes(pick(s.backgroundRepeat, 'repeat'))
  }
  return gradient
}

/** background-repeat -> whether the tile repeats along x and y. */
function repeatAxes(rep: string): [boolean, boolean] {
  if (rep === 'repeat-x') {
    return [true, false]
  }
  if (rep === 'repeat-y') {
    return [false, true]
  }
  const [x = 'repeat', y = x] = rep.split(/\s+/)
  return [x !== 'no-repeat', y !== 'no-repeat']
}

/** Explicit background-size lengths in CSS px against the positioning
 * area `w`×`h` ([w, h], null for auto), or null for auto / cover /
 * contain / `100% 100%`. */
export function backgroundSize(
  size: string,
  w: number,
  h: number
): [number | null, number | null] | null {
  const s = size.trim()
  if (
    s === '' ||
    s === 'auto' ||
    s === 'auto auto' ||
    s === 'cover' ||
    s === 'contain' ||
    s === '100% 100%'
  ) {
    return null
  }
  const parts = s.split(/\s+/)
  const len = (tok: string | undefined, dim: number): number | null => {
    if (tok === undefined || tok === 'auto') {
      return null
    }
    const n = Number.parseFloat(tok)
    if (!Number.isFinite(n)) {
      return null
    }
    return tok.endsWith('%') ? (n / 100) * dim : n
  }
  const out: [number | null, number | null] = [
    len(parts[0], w),
    len(parts[1], h)
  ]
  return out[0] === null && out[1] === null ? null : out
}

/** `background-position` -> px offsets of a `w`×`h` tile in the free
 * space (`freeW`×`freeH`, area minus tile): keywords, % and px; the
 * four-value form falls back to the fraction mapping. */
export function positionPx(
  value: string,
  freeW: number,
  freeH: number
): [number, number] {
  const toks = value.trim().split(/\s+/).filter(Boolean)
  const one = (tok: string | undefined, free: number): number | null => {
    if (tok === undefined) {
      return null
    }
    const k = positionComponent(tok)
    if (k !== null && !/px$/.test(tok)) {
      return k * free
    }
    const n = Number.parseFloat(tok)
    return Number.isFinite(n) ? n : null
  }
  if (toks.length === 2) {
    const x = one(toks[0], freeW)
    const y = one(toks[1], freeH)
    if (x !== null && y !== null) {
      return [x, y]
    }
  }
  const [fx, fy] = mapBackgroundPosition(value)
  return [fx * freeW, fy * freeH]
}

/**
 * Background-clip of layer `i` as insets from the border box, or null for
 * border-box (and `text`).
 */
export function layerClipInset(
  s: CSSStyleDeclaration,
  i: number
): [number, number, number, number] | null {
  const clips = splitTopLevel(s.backgroundClip || 'border-box', ',')
  const clip = (clips[i % Math.max(1, clips.length)] ?? '').trim()
  return clip === 'padding-box' || clip === 'content-box'
    ? boxInset(s, clip)
    : null
}

/**
 * background-clip of the bottom layer (it clips background-color) as
 * insets from the border box, or null for border-box. `text` is treated as
 * border-box.
 */
function readBgInset(
  s: CSSStyleDeclaration
): [number, number, number, number] | null {
  // The bottom layer's entry (the list repeats or is cut to the layers).
  const n = Math.max(1, backgroundLayers(s.backgroundImage).length)
  return layerClipInset(s, n - 1)
}

/**
 * Insets [top, right, bottom, left] of a CSS box (`border-box`,
 * `padding-box`, `content-box`) from the border box. Reads the widths
 * directly: a transparent border still insets the padding box.
 */
export function boxInset(
  s: CSSStyleDeclaration,
  box: string
): [number, number, number, number] {
  const w = (width: string, style: string) =>
    NO_BORDER_STYLE.has(style) ? 0 : px(width)
  const inset: [number, number, number, number] = [0, 0, 0, 0]
  if (box !== 'padding-box' && box !== 'content-box') {
    return inset
  }
  inset[0] = w(s.borderTopWidth, s.borderTopStyle)
  inset[1] = w(s.borderRightWidth, s.borderRightStyle)
  inset[2] = w(s.borderBottomWidth, s.borderBottomStyle)
  inset[3] = w(s.borderLeftWidth, s.borderLeftStyle)
  if (box === 'content-box') {
    inset[0] += px(s.paddingTop)
    inset[1] += px(s.paddingRight)
    inset[2] += px(s.paddingBottom)
    inset[3] += px(s.paddingLeft)
  }
  return inset
}

/** Border radii of an inset box: each corner's radius minus the larger of
 * its two adjacent insets, clamped at 0. */
export function insetCorners(
  radius: Corners,
  [t, r, b, l]: [number, number, number, number]
): Corners {
  return [
    Math.max(0, radius[0] - Math.max(t, l)),
    Math.max(0, radius[1] - Math.max(t, r)),
    Math.max(0, radius[2] - Math.max(b, r)),
    Math.max(0, radius[3] - Math.max(b, l))
  ]
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

/**
 * The element's `outline` as a border-only box around its border box,
 * grown by `outline-offset` + `outline-width` on each side (in local
 * space, so it follows a transform), or null when none paints. Corners
 * follow `border-radius` as Chrome does (r + offset + width where r > 0).
 * `auto` (the default focus ring) draws solid in the computed colour;
 * dashed/dotted/double keep their style, groove/ridge/inset/outset draw
 * solid like borders.
 */
export function readOutline(
  s: CSSStyleDeclaration,
  id: number,
  place: Placement
): BoxRecord | null {
  const style = s.outlineStyle
  if (s.visibility !== 'visible' || style === 'none' || style === 'hidden') {
    return null
  }
  const w = px(s.outlineWidth)
  const color = parseColor(s.outlineColor)
  if (!(w > 0) || color.a <= 0.001) {
    return null
  }
  const lw = place.local.w
  const lh = place.local.h
  const e = px(s.outlineOffset) + w
  const ow = lw + 2 * e
  const oh = lh + 2 * e
  if (ow <= 0 || oh <= 0) {
    return null
  }
  const [a, b, c, d, tx, ty] = place.xform
  // Local origin moves to (-e, -e).
  const xform: Placement['xform'] = [
    a,
    b,
    c,
    d,
    tx - a * e - c * e,
    ty - b * e - d * e
  ]
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [u, v] of [
    [0, 0],
    [ow, 0],
    [0, oh],
    [ow, oh]
  ] as const) {
    const x = a * u + c * v + xform[4]
    const y = b * u + d * v + xform[5]
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  const rr = recordRadii(s, { x: 0, y: 0, width: lw, height: lh })
  const grow = (r: Corners): Corners =>
    r.map((v) => (v > 0 ? Math.max(0, v + e) : 0)) as Corners
  const radius = grow(rr.radius)
  const code = BORDER_STYLE_CODE[style] ?? 0
  return {
    kind: 'box',
    id,
    rect: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    xform,
    local: { w: ow, h: oh },
    radius,
    ...(rr.radiusY ? { radiusY: grow(rr.radiusY) } : {}),
    fill: { r: 0, g: 0, b: 0, a: 0 },
    gradient: null,
    border: {
      widths: [w, w, w, w],
      colors: [color, color, color, color],
      styles: [code, code, code, code]
    },
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
    ...recordRadii(s, {
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
/** clampCorners per axis: horizontal radii against the width, vertical
 * against the height, one factor for both. */
function clampCornersXY(
  x: Corners,
  y: Corners,
  w: number,
  h: number
): { x: Corners; y: Corners } {
  const ratio = (sum: number, dim: number) => (sum > 0 ? dim / sum : 1)
  const f = Math.min(
    1,
    ratio(x[0] + x[1], w),
    ratio(x[3] + x[2], w),
    ratio(y[0] + y[3], h),
    ratio(y[1] + y[2], h)
  )
  return {
    x: x.map((v) => v * f) as Corners,
    y: y.map((v) => v * f) as Corners
  }
}

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
  const rr = readCornerRadii(s, { x: 0, y: 0, width: w, height: h })
  const elliptical = rr.x.some((v, k) => v !== rr.y[k])
  const radius = elliptical
    ? rr.x
    : readCorners(s, { x: 0, y: 0, width: w, height: h })
  const radiusY = elliptical ? rr.y : null
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
      const rec = insetShadow(s, place, radius, radiusY, layer, color, alloc())
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
    const grow = (r: Corners): Corners =>
      r.map((v) => (v > 0 ? Math.max(0, v + spread) : 0)) as Corners
    const grown = grow(radius)
    const xy = radiusY ? clampCornersXY(grown, grow(radiusY), sw, sh) : null
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
      radius: xy ? xy.x : clampCorners(grown, sw, sh),
      ...(xy ? { radiusY: xy.y } : {}),
      fill: color,
      gradient: null,
      border: null,
      shadow: {
        color,
        blur,
        inner: {
          x: -x0,
          y: -y0,
          w,
          h,
          radius,
          ...(radiusY ? { radiusY } : {})
        }
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
  radiusY: Corners | null,
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
  if (radiusY) {
    // Elliptical: each axis inset by its own side's width.
    const [x0, x1, x2, x3] = radius
    const [y0, y1, y2, y3] = radiusY
    const px: Corners = [
      Math.max(0, x0 - bl),
      Math.max(0, x1 - br),
      Math.max(0, x2 - br),
      Math.max(0, x3 - bl)
    ]
    const py: Corners = [
      Math.max(0, y0 - bt),
      Math.max(0, y1 - bt),
      Math.max(0, y2 - bb),
      Math.max(0, y3 - bb)
    ]
    const shrink = (r: Corners): Corners =>
      r.map((v) => (v > 0 ? Math.max(0, v - spread) : 0)) as Corners
    const inner = clampCornersXY(shrink(px), shrink(py), sw, sh)
    return {
      kind: 'box',
      id,
      rect: placementAabb(sp),
      xform: sp.xform,
      local: sp.local,
      radius: px,
      radiusY: py,
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
          radius: inner.x,
          radiusY: inner.y
        },
        inset: true
      },
      opacity: 1,
      z: 0
    }
  }
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
