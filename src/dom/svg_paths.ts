import { type BakedSvg, viewBoxMap } from '../assets/vector_file'
import {
  ellipsePath,
  flattenPathData,
  type PathSink,
  polyPath,
  rectPath,
  replayTape
} from '../paths/path_data'
import type {
  LineCap,
  LineJoin,
  PathRecord,
  Rect,
  RGBA
} from '../scene/records'
import { tryParseColor } from '../util/color'
import { log } from '../util/log'
import { type Affine, composeAffine, type Placement } from './transform'

// Inline svgs drawn as vectors (M5b): an svg root with `data-gpu-vector`
// or `data-gpu-morph` becomes one PathRecord per painted shape instead
// of one rasterised ImageRecord (svg.ts). Each shape's outline is
// flattened to line segments here, in path space: the svg's viewport (CSS
// px from its content box, viewBox and element transforms applied, via
// getCTM). The path pass fills by winding and strokes by distance to the
// centreline (paths/path_pass.ts).
//
// Supported: path, rect, circle, ellipse, line, polyline, polygon, g, a,
// and in-document <use> of those; solid fill and stroke (currentColor
// resolves through the computed style), fill-rule, stroke-width,
// -linecap, -linejoin, -miterlimit, opacity, fill-opacity,
// stroke-opacity. Anything else (gradients, patterns, clip-path, mask,
// filter, markers, dashes, text, images, nested svg, symbol, group
// opacity, non-uniform scale under a stroke) returns null: the caller
// draws the svg rasterised, as before, and a warning names the feature
// once per svg.

export const VECTOR_ATTR = 'data-gpu-vector'
export const MORPH_ATTR = 'data-gpu-morph'
/** Edges a morphing path may have (it's drawn brute force: no bands). */
export const MORPH_MAX_EDGES = 256
/** Device px a flattened curve may stray from the true one. */
const TOLERANCE_PX = 0.2
/** Points per svg before it is drawn rasterised instead. */
const MAX_POINTS = 50_000

/** Is `el` an svg root the page asked to draw as vectors? */
export function wantsVector(el: Element): boolean {
  return el.hasAttribute(VECTOR_ATTR) || el.hasAttribute(MORPH_ATTR)
}

class Unsupported extends Error {}

const warned = new WeakMap<Element, Set<string>>()

function warnOnce(el: Element, reason: string): void {
  let seen = warned.get(el)
  if (!seen) {
    seen = new Set()
    warned.set(el, seen)
  }
  if (!seen.has(reason)) {
    seen.add(reason)
    log.warn(`svg drawn rasterised (${reason}):`, el)
  }
}

/** Points and subpaths being flattened, in path space. */
class Flat implements PathSink {
  pts: number[] = []
  contours: number[] = []
  private start = -1

  constructor(
    readonly m: Affine,
    /** Flattening tolerance in path space. */
    readonly tol: number
  ) {}

  /** Largest scale `m` applies (its larger singular value). */
  get scale(): number {
    return maxScale(this.m)
  }

  private push(x: number, y: number): void {
    const m = this.m
    this.pts.push(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
  }

  moveTo(x: number, y: number): void {
    this.end(false)
    this.start = this.pts.length / 2
    this.push(x, y)
  }

  lineTo(x: number, y: number): void {
    if (this.start < 0) {
      this.moveTo(x, y)
      return
    }
    this.push(x, y)
  }

  /** Close (or leave open) the current subpath. */
  end(closed: boolean): void {
    if (this.start < 0) {
      return
    }
    const n = this.pts.length / 2 - this.start
    if (n >= 2) {
      this.contours.push(this.start, n, closed ? 1 : 0)
    } else {
      this.pts.length = this.start * 2
    }
    this.start = -1
  }

  quadTo(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ) {
    const s = this.scale
    const dd = Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2) * s
    const n = Math.max(1, Math.ceil(Math.sqrt((0.25 * dd) / this.tol)))
    for (let i = 1; i <= n; i++) {
      const t = i / n
      const u = 1 - t
      this.lineTo(
        u * u * x0 + 2 * u * t * x1 + t * t * x2,
        u * u * y0 + 2 * u * t * y1 + t * t * y2
      )
    }
  }

  cubicTo(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number
  ): void {
    // Wang's formula: segments for a cubic within `tol`.
    const s = this.scale
    const dd =
      Math.max(
        Math.hypot(x0 - 2 * x1 + x2, y0 - 2 * y1 + y2),
        Math.hypot(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3)
      ) * s
    const n = Math.max(1, Math.ceil(Math.sqrt((0.75 * dd) / this.tol)))
    for (let i = 1; i <= n; i++) {
      const t = i / n
      const u = 1 - t
      const a = u * u * u
      const b = 3 * u * u * t
      const c = 3 * u * t * t
      const d = t * t * t
      this.lineTo(
        a * x0 + b * x1 + c * x2 + d * x3,
        a * y0 + b * y1 + c * y2 + d * y3
      )
    }
  }

  /** Steps for an arc of radius r (user units) through `sweep` radians. */
  arcSteps(r: number, sweep: number): number {
    const rs = r * this.scale
    if (rs <= this.tol) {
      return 1
    }
    const step = 2 * Math.acos(Math.max(-1, 1 - this.tol / rs))
    return Math.max(1, Math.ceil(Math.abs(sweep) / Math.max(step, 1e-3)))
  }

  /** Ellipse arc around (cx, cy), radii rx ry, x axis rotated by phi,
   * from angle a0 through `sweep`; the start point is not pushed. */
  arc(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    phi: number,
    a0: number,
    sweep: number
  ): void {
    const n = this.arcSteps(Math.max(rx, ry), sweep)
    const cp = Math.cos(phi)
    const sp = Math.sin(phi)
    for (let i = 1; i <= n; i++) {
      const a = a0 + (sweep * i) / n
      const x = rx * Math.cos(a)
      const y = ry * Math.sin(a)
      this.lineTo(cx + cp * x - sp * y, cy + sp * x + cp * y)
    }
  }
}

function maxScale(m: Affine): number {
  const [a, b, c, d] = m
  const s1 = a * a + b * b + c * c + d * d
  const det = a * d - b * c
  const disc = Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det))
  return Math.sqrt((s1 + disc) / 2)
}

function minScale(m: Affine): number {
  const [a, b, c, d] = m
  const s1 = a * a + b * b + c * c + d * d
  const det = a * d - b * c
  const disc = Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det))
  return Math.sqrt(Math.max(0, (s1 - disc) / 2))
}

// --- Shapes ----------------------------------------------------------------

const len = (v: SVGAnimatedLength): number => v.animVal.value

function flattenShape(el: SVGElement, f: Flat): void {
  if (el instanceof SVGPathElement) {
    flattenPathData(el.getAttribute('d') ?? '', f)
    return
  }
  if (el instanceof SVGRectElement) {
    // rx / ry: an absent one takes the other's value.
    const hasRx = el.hasAttribute('rx')
    const hasRy = el.hasAttribute('ry')
    const rx = hasRx ? len(el.rx) : hasRy ? len(el.ry) : 0
    const ry = hasRy ? len(el.ry) : rx
    rectPath(f, len(el.x), len(el.y), len(el.width), len(el.height), rx, ry)
    return
  }
  if (el instanceof SVGCircleElement) {
    ellipsePath(f, len(el.cx), len(el.cy), len(el.r), len(el.r))
    return
  }
  if (el instanceof SVGEllipseElement) {
    ellipsePath(f, len(el.cx), len(el.cy), len(el.rx), len(el.ry))
    return
  }
  if (el instanceof SVGLineElement) {
    polyPath(f, [len(el.x1), len(el.y1), len(el.x2), len(el.y2)], false)
    return
  }
  if (el instanceof SVGPolylineElement || el instanceof SVGPolygonElement) {
    const pts = el.points
    const xy: number[] = []
    for (let k = 0; k < pts.numberOfItems; k++) {
      const p = pts.getItem(k)
      xy.push(p.x, p.y)
    }
    polyPath(f, xy, el instanceof SVGPolygonElement)
  }
}

// --- Paint -----------------------------------------------------------------

const CAPS: Record<string, LineCap> = { butt: 0, round: 1, square: 2 }
const JOINS: Record<string, LineJoin> = {
  miter: 0,
  'miter-clip': 0,
  arcs: 0,
  round: 1,
  bevel: 2
}

/** A solid paint, null for none; throws for anything else. */
function paint(v: string, what: string): RGBA | null {
  if (v === 'none') {
    return null
  }
  if (v.startsWith('url(') || v.startsWith('context-')) {
    throw new Unsupported(`${what} ${v.split(')')[0]})`)
  }
  const c = tryParseColor(v)
  if (!c) {
    throw new Unsupported(`${what} ${v}`)
  }
  return c
}

const alphaTimes = (c: RGBA, k: number): RGBA => ({ ...c, a: c.a * k })

function checkEffects(s: CSSStyleDeclaration): void {
  if (s.clipPath && s.clipPath !== 'none') {
    throw new Unsupported('clip-path')
  }
  if (s.mask && s.mask !== 'none') {
    throw new Unsupported('mask')
  }
  if (s.filter && s.filter !== 'none') {
    throw new Unsupported('filter')
  }
  if (s.mixBlendMode && s.mixBlendMode !== 'normal') {
    throw new Unsupported('mix-blend-mode')
  }
}

// --- Walk ------------------------------------------------------------------

const SHAPES = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon'
])
const SKIP = new Set([
  'defs',
  'title',
  'desc',
  'metadata',
  'style',
  'script',
  'linearGradient',
  'radialGradient',
  'pattern',
  'clipPath',
  'mask',
  'marker',
  'filter',
  'symbol'
])

const toAffine = (m: DOMMatrix): Affine => [m.a, m.b, m.c, m.d, m.e, m.f]

function invert(m: Affine): Affine | null {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  if (Math.abs(det) < 1e-12) {
    return null
  }
  const ia = d / det
  const ib = -b / det
  const ic = -c / det
  const id = a / det
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)]
}

/** The paint properties a shape is drawn with. */
const PAINT_PROPS = [
  'fill',
  'stroke',
  'strokeWidth',
  'strokeLinecap',
  'strokeLinejoin',
  'strokeMiterlimit',
  'fillOpacity',
  'strokeOpacity',
  'fillRule',
  'strokeDasharray',
  'paintOrder'
] as const
type PaintStyle = Record<(typeof PAINT_PROPS)[number], string>

const CSS_NAME: Record<(typeof PAINT_PROPS)[number], string> = {
  fill: 'fill',
  stroke: 'stroke',
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  strokeMiterlimit: 'stroke-miterlimit',
  fillOpacity: 'fill-opacity',
  strokeOpacity: 'stroke-opacity',
  fillRule: 'fill-rule',
  strokeDasharray: 'stroke-dasharray',
  paintOrder: 'paint-order'
}

/**
 * The paint `el` is drawn with. Content reached through <use> inherits
 * each property from the <use> (`inherit`) unless it sets it itself: its
 * computed style reflects its original place in the document, not the
 * <use>'s instance tree. Approximate: a property set by a stylesheet rule
 * on the content counts as inherited.
 */
function paintStyle(
  el: SVGElement,
  s: CSSStyleDeclaration,
  inherit: CSSStyleDeclaration | null
): PaintStyle {
  const out = {} as PaintStyle
  for (const p of PAINT_PROPS) {
    const own =
      !inherit ||
      el.hasAttribute(CSS_NAME[p]) ||
      el.style.getPropertyValue(CSS_NAME[p]) !== ''
    out[p] = (own ? s : inherit)[p]
  }
  return out
}

/** One shape found by the walk: the element, its user space -> path
 * space matrix, and its paint. */
interface Found {
  el: SVGElement
  m: Affine
  paint: PaintStyle
}

function ctmOf(el: Element): Affine {
  const m = (el as SVGGraphicsElement).getCTM?.()
  if (!m) {
    throw new Unsupported('no CTM')
  }
  return toAffine(m)
}

/** The element's own `transform` attribute (consolidated). */
function ownTransform(el: Element): Affine {
  const list = (el as SVGGraphicsElement).transform?.baseVal
  const m = list?.consolidate()?.matrix
  return m ? toAffine(m) : [1, 0, 0, 1, 0, 0]
}

/**
 * Collect the shapes under `el` in paint order. `base` (for content
 * reached through <use>) maps the content's original CTMs into path
 * space; `inherit` is the <use>'s computed style, which referenced
 * content without its own fill or stroke inherits.
 */
function walk(
  el: Element,
  out: Found[],
  base: Affine | null,
  inherit: CSSStyleDeclaration | null,
  depth: number
): void {
  for (const kid of el.children) {
    const tag = kid.localName
    if (SKIP.has(tag)) {
      continue
    }
    const s = getComputedStyle(kid)
    if (s.display === 'none') {
      continue
    }
    checkEffects(s)
    if (tag === 'g' || tag === 'a') {
      if (Number.parseFloat(s.opacity) < 1) {
        throw new Unsupported('group opacity')
      }
      walk(kid, out, base, inherit, depth)
      continue
    }
    if (tag === 'use') {
      if (depth > 8) {
        throw new Unsupported('<use> nesting')
      }
      const href =
        kid.getAttribute('href') ?? kid.getAttribute('xlink:href') ?? ''
      const ref = href.startsWith('#')
        ? kid.ownerDocument.getElementById(href.slice(1))
        : null
      if (!ref) {
        throw new Unsupported(`<use href="${href}">`)
      }
      if (ref.localName === 'symbol' || ref.localName === 'svg') {
        throw new Unsupported(`<use> of <${ref.localName}>`)
      }
      if (Number.parseFloat(s.opacity) < 1) {
        throw new Unsupported('<use> opacity')
      }
      const use = kid as SVGUseElement
      const at: Affine = [1, 0, 0, 1, len(use.x), len(use.y)]
      const useM = composeAffine(
        base ? composeAffine(base, ctmOf(kid)) : ctmOf(kid),
        at
      )
      // ref's original CTM without its own transform: its parent's.
      const parentOrig = composeAffine(
        ctmOf(ref),
        invert(ownTransform(ref)) ?? [1, 0, 0, 1, 0, 0]
      )
      const strip = invert(parentOrig)
      if (!strip) {
        throw new Unsupported('<use> transform')
      }
      const refBase = composeAffine(useM, strip)
      if (SHAPES.has(ref.localName)) {
        const shape = ref as unknown as SVGElement
        out.push({
          el: shape,
          m: composeAffine(refBase, ctmOf(ref)),
          paint: paintStyle(shape, getComputedStyle(shape), s)
        })
      } else if (ref.localName === 'g') {
        walk(ref, out, refBase, s, depth + 1)
      } else {
        throw new Unsupported(`<use> of <${ref.localName}>`)
      }
      continue
    }
    if (SHAPES.has(tag)) {
      const shape = kid as SVGElement
      out.push({
        el: shape,
        m: base ? composeAffine(base, ctmOf(kid)) : ctmOf(kid),
        paint: paintStyle(shape, s, inherit)
      })
      continue
    }
    throw new Unsupported(`<${tag}>`)
  }
}

/**
 * The PathRecords for a vector-drawn svg root, in paint order, or null
 * when it uses something the path pass doesn't draw (the caller then
 * rasterises it). `ids` allocates record ids.
 */
export function readSvgPaths(
  el: SVGSVGElement,
  s: CSSStyleDeclaration,
  place: Placement,
  clip: Rect | null,
  ids: () => number
): PathRecord[] | null {
  if (s.visibility !== 'visible') {
    return []
  }
  const found: Found[] = []
  try {
    walk(el, found, null, null, 0)
  } catch (err) {
    if (err instanceof Unsupported) {
      warnOnce(el, err.message)
      return null
    }
    throw err
  }
  // Path space: the svg's content box (its viewport) in its local box.
  const ox =
    Number.parseFloat(s.borderLeftWidth) + Number.parseFloat(s.paddingLeft)
  const oy =
    Number.parseFloat(s.borderTopWidth) + Number.parseFloat(s.paddingTop)
  const xform = composeAffine(place.xform, [1, 0, 0, 1, ox || 0, oy || 0])
  const dpr = window.devicePixelRatio || 1
  const devScale = Math.max(maxScale(xform) * dpr, 1e-3)
  const tol = TOLERANCE_PX / devScale
  return collect(
    el,
    found.map((f) => () => shapeRecord(f, xform, tol, place, clip, ids))
  )
}

/** Run each shape's record maker, in paint order, under the limits: null
 * (draw `el` rasterised) when one hits something unsupported or the
 * whole goes over MAX_POINTS (or MORPH_MAX_EDGES a path, morphing). */
function collect(
  el: Element,
  makers: (() => PathRecord | null)[]
): PathRecord[] | null {
  const morph = el.hasAttribute(MORPH_ATTR)
  const out: PathRecord[] = []
  let total = 0
  for (const make of makers) {
    let rec: PathRecord | null
    try {
      rec = make()
    } catch (err) {
      if (err instanceof Unsupported) {
        warnOnce(el, err.message)
        return null
      }
      throw err
    }
    if (!rec) {
      continue
    }
    total += rec.points.length / 2
    if (total > MAX_POINTS) {
      warnOnce(el, `over ${MAX_POINTS} points`)
      return null
    }
    if (morph && edgeCount(rec) > MORPH_MAX_EDGES) {
      warnOnce(el, `a morphing path over ${MORPH_MAX_EDGES} edges`)
      return null
    }
    out.push(rec)
  }
  return out
}

/**
 * The PathRecords for an `<img data-gpu-vector>` (or data-gpu-morph)
 * whose svg file was baked (M5f; tools/bake_svg.ts): its shapes in
 * the img's content box, per the file's viewBox and preserveAspectRatio,
 * flattened as an inline svg's are. Null when the img can't be drawn
 * this way (object-fit other than fill, a slice that would crop, or
 * paint the pass doesn't draw): the caller draws the image as before.
 */
export function readImgPaths(
  el: HTMLImageElement,
  s: CSSStyleDeclaration,
  svg: BakedSvg,
  place: Placement,
  clip: Rect | null,
  ids: () => number
): PathRecord[] | null {
  if (s.visibility !== 'visible') {
    return []
  }
  if (s.objectFit && s.objectFit !== 'fill') {
    warnOnce(el, `object-fit: ${s.objectFit}`)
    return null
  }
  const px = (v: string): number => Number.parseFloat(v) || 0
  const ox = px(s.borderLeftWidth) + px(s.paddingLeft)
  const oy = px(s.borderTopWidth) + px(s.paddingTop)
  const w = place.local.w - ox - px(s.borderRightWidth) - px(s.paddingRight)
  const h = place.local.h - oy - px(s.borderBottomWidth) - px(s.paddingBottom)
  if (w <= 0 || h <= 0) {
    return []
  }
  const vb = viewBoxMap(svg, w, h)
  if (!vb) {
    warnOnce(el, 'preserveAspectRatio slice')
    return null
  }
  const xform = composeAffine(place.xform, [1, 0, 0, 1, ox, oy])
  const dpr = window.devicePixelRatio || 1
  const devScale = Math.max(maxScale(xform) * dpr, 1e-3)
  const tol = TOLERANCE_PX / devScale
  return collect(
    el,
    svg.shapes.map((sh) => () => {
      const p = shapePaint(sh)
      return p
        ? pathRecord(
            (f) => replayTape(svg.tape, f, sh.start, sh.end),
            composeAffine(vb, sh.m),
            p,
            xform,
            tol,
            place,
            clip,
            ids
          )
        : null
    })
  )
}

/** Edges the pass tests for `r`: fill edges, plus stroke edges. */
export function edgeCount(r: PathRecord): number {
  let n = 0
  for (let k = 0; k < r.contours.length; k += 3) {
    const count = r.contours[k + 1] ?? 0
    const closed = r.contours[k + 2] === 1
    if (r.fill) {
      n += count
    }
    if (r.stroke) {
      n += closed ? count : count - 1
    }
  }
  return n
}

function shapeRecord(
  f: Found,
  xform: Affine,
  tol: number,
  place: Placement,
  clip: Rect | null,
  ids: () => number
): PathRecord | null {
  const s = getComputedStyle(f.el)
  if (s.visibility !== 'visible') {
    return null
  }
  const ps = f.paint
  if (ps.strokeDasharray && ps.strokeDasharray !== 'none') {
    throw new Unsupported('stroke-dasharray')
  }
  if (
    (s.markerStart && s.markerStart !== 'none') ||
    (s.markerMid && s.markerMid !== 'none') ||
    (s.markerEnd && s.markerEnd !== 'none')
  ) {
    throw new Unsupported('markers')
  }
  if (ps.paintOrder && ps.paintOrder !== 'normal') {
    throw new Unsupported('paint-order')
  }
  if (s.vectorEffect && s.vectorEffect !== 'none') {
    throw new Unsupported('vector-effect')
  }
  const p = shapePaint({
    fill: ps.fill,
    stroke: ps.stroke,
    opacity: Number.parseFloat(s.opacity),
    fillOpacity: Number.parseFloat(ps.fillOpacity),
    strokeOpacity: Number.parseFloat(ps.strokeOpacity),
    strokeWidth: Number.parseFloat(ps.strokeWidth) || 0,
    cap: CAPS[ps.strokeLinecap] ?? 0,
    join: JOINS[ps.strokeLinejoin] ?? 0,
    miterLimit: Number.parseFloat(ps.strokeMiterlimit) || 4,
    evenOdd: ps.fillRule === 'evenodd'
  })
  if (!p) {
    return null
  }
  return pathRecord(
    (sink) => flattenShape(f.el, sink),
    f.m,
    p,
    xform,
    tol,
    place,
    clip,
    ids
  )
}

/** A shape's paint as read (computed style, or a baked svg's). */
export interface PaintInput {
  /** CSS paint: 'none' or a colour. */
  fill: string
  stroke: string
  opacity: number
  fillOpacity: number
  strokeOpacity: number
  /** User units. */
  strokeWidth: number
  cap: LineCap
  join: LineJoin
  miterLimit: number
  evenOdd: boolean
}

interface Paint {
  fill: RGBA | null
  stroke: RGBA | null
  strokeWidth: number
  cap: LineCap
  join: LineJoin
  miterLimit: number
  evenOdd: boolean
}

/** Colours with the opacities applied, null when nothing paints; throws
 * Unsupported for paint the pass doesn't draw. */
function shapePaint(i: PaintInput): Paint | null {
  let fill = paint(i.fill, 'fill')
  let stroke = paint(i.stroke, 'stroke')
  if (stroke && i.strokeWidth <= 0) {
    stroke = null
  }
  if (fill && stroke && i.opacity < 1) {
    throw new Unsupported('opacity on a filled and stroked shape')
  }
  if (fill) {
    fill = alphaTimes(fill, i.opacity * i.fillOpacity)
  }
  if (stroke) {
    stroke = alphaTimes(stroke, i.opacity * i.strokeOpacity)
  }
  if ((!fill || fill.a <= 0) && (!stroke || stroke.a <= 0)) {
    return null
  }
  return {
    fill,
    stroke,
    strokeWidth: i.strokeWidth,
    cap: i.cap,
    join: i.join,
    miterLimit: Math.max(1, i.miterLimit),
    evenOdd: i.evenOdd
  }
}

/** One shape's record: `outline` drawn into a Flat through `m` (user
 * space -> path space), placed by `xform` (path space -> record space). */
function pathRecord(
  outline: (f: Flat) => void,
  m: Affine,
  p: Paint,
  xform: Affine,
  tol: number,
  place: Placement,
  clip: Rect | null,
  ids: () => number
): PathRecord | null {
  // A stroke's width is uniform in path space only under a uniform
  // scale.
  const hi = maxScale(m)
  const lo = minScale(m)
  if (p.stroke && hi - lo > 0.01 * hi) {
    throw new Unsupported('a stroke under non-uniform scale')
  }
  const flat = new Flat(m, tol)
  outline(flat)
  if (flat.contours.length === 0) {
    return null
  }
  const points = new Float32Array(flat.pts)
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (let k = 0; k < points.length; k += 2) {
    const x = points[k] ?? 0
    const y = points[k + 1] ?? 0
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  const width = p.stroke ? p.strokeWidth * hi : 0
  const { join, cap, miterLimit } = p
  const pad =
    (width / 2) *
      Math.max(join === 0 ? miterLimit : 1, cap === 2 ? Math.SQRT2 : 1) +
    1
  return {
    kind: 'path',
    id: ids(),
    z: 0,
    rect: boundsRect(xform, x0 - pad, y0 - pad, x1 + pad, y1 + pad),
    xform,
    local: place.local,
    clip,
    points,
    contours: new Uint32Array(flat.contours),
    bounds: [x0, y0, x1, y1],
    fill: p.fill,
    evenOdd: p.evenOdd,
    stroke: p.stroke,
    strokeWidth: width,
    cap,
    join,
    miterLimit
  }
}

/** The AABB of a path-space box through `m`. */
function boundsRect(
  m: Affine,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): Rect {
  let mx = Number.POSITIVE_INFINITY
  let my = Number.POSITIVE_INFINITY
  let nx = Number.NEGATIVE_INFINITY
  let ny = Number.NEGATIVE_INFINITY
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1]
  ] as const) {
    const px = m[0] * x + m[2] * y + m[4]
    const py = m[1] * x + m[3] * y + m[5]
    mx = Math.min(mx, px)
    my = Math.min(my, py)
    nx = Math.max(nx, px)
    ny = Math.max(ny, py)
  }
  return { x: mx, y: my, width: nx - mx, height: ny - my }
}
