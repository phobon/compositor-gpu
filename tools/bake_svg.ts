// Bake one svg file (M5f; src/assets/vector_file.ts): resolve what the
// runtime would read from the DOM for an inline svg (dom/svg_paths.ts),
// statically: the viewBox, each shape's matrix to the root's user space
// (transform attributes, <use> x / y), its paint (presentation attributes
// and style="" with svg inheritance; currentColor from `color`), and its
// outline as a path tape. The same features are supported as for inline
// svgs, and anything else (gradients, <style> rules, clip paths, masks,
// filters, markers, dashes, text, images, group opacity, lengths in
// units other than px) fails the file with a reason, so the page draws
// it as an image, as before.

import type { Affine6, BakedShape, BakedSvg } from '../src/assets/vector_file'
import {
  ellipsePath,
  flattenPathData,
  parsePoints,
  polyPath,
  rectPath,
  TapeSink
} from '../src/paths/path_data'
import type { LineCap, LineJoin } from '../src/scene/records'
import { parseXml, type XmlElement } from './xml'

export class BakeSvgError extends Error {}

const no = (reason: string): never => {
  throw new BakeSvgError(reason)
}

// Inherited properties and their initial values.
const INHERITED: Record<string, string> = {
  fill: 'black',
  stroke: 'none',
  'stroke-width': '1',
  'stroke-linecap': 'butt',
  'stroke-linejoin': 'miter',
  'stroke-miterlimit': '4',
  'fill-opacity': '1',
  'stroke-opacity': '1',
  'fill-rule': 'nonzero',
  color: 'black',
  visibility: 'visible',
  'stroke-dasharray': 'none',
  'paint-order': 'normal',
  'marker-start': 'none',
  'marker-mid': 'none',
  'marker-end': 'none'
}
// Not inherited: read per element.
const OWN = [
  'opacity',
  'display',
  'clip-path',
  'mask',
  'filter',
  'mix-blend-mode',
  'vector-effect',
  'transform'
]

type Style = Record<string, string>

/** An element's declared properties: presentation attributes, then its
 * style attribute over them. */
function declared(el: XmlElement): Style {
  const out: Style = {}
  for (const k of [...Object.keys(INHERITED), ...OWN, 'marker']) {
    const v = el.attrs.get(k)
    if (v !== undefined) {
      out[k] = v.trim()
    }
  }
  for (const decl of (el.attrs.get('style') ?? '').split(';')) {
    const c = decl.indexOf(':')
    if (c < 0) {
      continue
    }
    const k = decl.slice(0, c).trim().toLowerCase()
    const v = decl
      .slice(c + 1)
      .replace(/!important/i, '')
      .trim()
    if (k) {
      out[k] = v
    }
  }
  if (out.marker !== undefined) {
    for (const m of ['marker-start', 'marker-mid', 'marker-end']) {
      out[m] ??= out.marker
    }
  }
  return out
}

/** The inherited style of `el`'s children, and `el`'s own values. */
function cascade(el: XmlElement, parent: Style): { inh: Style; own: Style } {
  const d = declared(el)
  const inh: Style = { ...parent }
  for (const k of Object.keys(INHERITED)) {
    const v = d[k]
    if (v !== undefined && v !== 'inherit' && v !== '') {
      inh[k] = v === 'initial' ? (INHERITED[k] as string) : v
    }
  }
  const own: Style = {}
  for (const k of OWN) {
    const v = d[k]
    if (v !== undefined && v !== 'inherit' && v !== 'initial') {
      own[k] = v
    }
  }
  return { inh, own }
}

/** A plain number or px length. */
function length(v: string | undefined, what: string, def = 0): number {
  if (v === undefined || v.trim() === '') {
    return def
  }
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(px)?\s*$/.exec(v)
  if (!m) {
    return no(`${what}="${v}" (only plain numbers and px)`)
  }
  return Number(m[1])
}

const mul = (a: Affine6, b: Affine6): Affine6 => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5]
]
const ID: Affine6 = [1, 0, 0, 1, 0, 0]

/** An svg transform attribute (transform functions, svg 1.1 syntax). */
export function parseSvgTransform(s: string): Affine6 {
  let m: Affine6 = ID
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g
  for (const f of s.matchAll(re)) {
    const a = (f[2] ?? '')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    if (a.some((x) => !Number.isFinite(x))) {
      return no(`transform="${s}"`)
    }
    const r = (deg: number): number => (deg * Math.PI) / 180
    let t: Affine6
    switch (f[1]) {
      case 'matrix':
        if (a.length !== 6) {
          return no(`transform="${s}"`)
        }
        t = a as Affine6
        break
      case 'translate':
        t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]
        break
      case 'scale':
        t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]
        break
      case 'rotate': {
        const c = Math.cos(r(a[0] ?? 0))
        const sn = Math.sin(r(a[0] ?? 0))
        const cx = a[1] ?? 0
        const cy = a[2] ?? 0
        t = mul(mul([1, 0, 0, 1, cx, cy], [c, sn, -sn, c, 0, 0]), [
          1,
          0,
          0,
          1,
          -cx,
          -cy
        ])
        break
      }
      case 'skewX':
        t = [1, 0, Math.tan(r(a[0] ?? 0)), 1, 0, 0]
        break
      default:
        t = [1, Math.tan(r(a[0] ?? 0)), 0, 1, 0, 0]
    }
    m = mul(m, t)
  }
  if (s.replace(re, '').replace(/[\s,]/g, '') !== '') {
    return no(`transform="${s}"`)
  }
  return m
}

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
const CAPS: Record<string, LineCap> = { butt: 0, round: 1, square: 2 }
const JOINS: Record<string, LineJoin> = {
  miter: 0,
  'miter-clip': 0,
  arcs: 0,
  round: 1,
  bevel: 2
}

function checkOwn(own: Style, tag: string): void {
  if ((own.display ?? '') === 'none') {
    return
  }
  for (const k of ['clip-path', 'mask', 'filter']) {
    const v = own[k]
    if (v && v !== 'none') {
      no(k)
    }
  }
  const blend = own['mix-blend-mode']
  if (blend && blend !== 'normal') {
    no('mix-blend-mode')
  }
  const ve = own['vector-effect']
  if (ve && ve !== 'none') {
    no('vector-effect')
  }
  if (tag !== 'shape' && Number.parseFloat(own.opacity ?? '1') < 1) {
    no(tag === 'use' ? '<use> opacity' : 'group opacity')
  }
}

/** A paint as the runtime parses it: 'none' or a colour string. */
function paintOf(v: string, color: string, what: string): string {
  if (v === 'none') {
    return v
  }
  if (v.startsWith('url(') || v.startsWith('context-')) {
    return no(`${what} ${v.split(')')[0]})`)
  }
  return v.toLowerCase() === 'currentcolor' ? color : v
}

/** Bake an svg file's source. `name` labels errors. */
export function bakeSvg(src: string, name = 'svg'): BakedSvg {
  let root: XmlElement
  try {
    root = parseXml(src)
  } catch (err) {
    return no(`${name}: ${(err as Error).message}`)
  }
  if (root.name !== 'svg') {
    return no(`${name}: the root is <${root.name}>, not <svg>`)
  }
  const ids = new Map<string, XmlElement>()
  const index = (el: XmlElement): void => {
    if (el.name === 'style' && el.text.trim()) {
      no('<style> rules')
    }
    const id = el.attrs.get('id')
    if (id && !ids.has(id)) {
      ids.set(id, el)
    }
    for (const k of el.children) {
      index(k)
    }
  }
  index(root)

  // The viewBox (or the root's size without one, as browsers synthesize
  // for svg images).
  let viewBox: [number, number, number, number]
  const vbAttr = root.attrs.get('viewBox')
  if (vbAttr) {
    const v = vbAttr
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) {
      return no(`viewBox="${vbAttr}"`)
    }
    viewBox = v as [number, number, number, number]
  } else {
    const w = length(root.attrs.get('width'), 'width', Number.NaN)
    const h = length(root.attrs.get('height'), 'height', Number.NaN)
    if (!(w > 0 && h > 0)) {
      return no('no viewBox and no width / height')
    }
    viewBox = [0, 0, w, h]
  }
  const par = (root.attrs.get('preserveAspectRatio') ?? 'xMidYMid meet')
    .replace(/^\s*defer\s+/, '')
    .trim()
    .split(/\s+/)
  const align = par[0] ?? 'xMidYMid'
  if (!/^(none|x(Min|Mid|Max)Y(Min|Mid|Max))$/.test(align)) {
    return no(`preserveAspectRatio="${par.join(' ')}"`)
  }
  const slice = par[1] === 'slice'

  const tape = new TapeSink()
  const shapes: BakedShape[] = []

  const shape = (el: XmlElement, m: Affine6, st: Style, own: Style): void => {
    if (st.visibility !== 'visible') {
      return
    }
    if (st['stroke-dasharray'] !== 'none') {
      no('stroke-dasharray')
    }
    for (const k of ['marker-start', 'marker-mid', 'marker-end']) {
      if (st[k] !== 'none') {
        no('markers')
      }
    }
    if (st['paint-order'] !== 'normal') {
      no('paint-order')
    }
    const start = tape.ops.length
    const a = (k: string, def = 0): number => length(el.attrs.get(k), k, def)
    switch (el.name) {
      case 'path':
        flattenPathData(el.attrs.get('d') ?? '', tape)
        break
      case 'rect': {
        const hasRx = el.attrs.has('rx') && el.attrs.get('rx') !== 'auto'
        const hasRy = el.attrs.has('ry') && el.attrs.get('ry') !== 'auto'
        const rx = hasRx ? a('rx') : hasRy ? a('ry') : 0
        const ry = hasRy ? a('ry') : rx
        rectPath(tape, a('x'), a('y'), a('width'), a('height'), rx, ry)
        break
      }
      case 'circle':
        ellipsePath(tape, a('cx'), a('cy'), a('r'), a('r'))
        break
      case 'ellipse':
        ellipsePath(tape, a('cx'), a('cy'), a('rx'), a('ry'))
        break
      case 'line':
        polyPath(tape, [a('x1'), a('y1'), a('x2'), a('y2')], false)
        break
      default:
        polyPath(
          tape,
          parsePoints(el.attrs.get('points') ?? ''),
          el.name === 'polygon'
        )
    }
    const end = tape.ops.length
    if (end === start) {
      return
    }
    const color = st.color ?? 'black'
    shapes.push({
      m,
      fill: paintOf(st.fill ?? 'black', color, 'fill'),
      stroke: paintOf(st.stroke ?? 'none', color, 'stroke'),
      opacity: Number.parseFloat(own.opacity ?? '1'),
      fillOpacity: Number.parseFloat(st['fill-opacity'] ?? '1'),
      strokeOpacity: Number.parseFloat(st['stroke-opacity'] ?? '1'),
      strokeWidth: length(st['stroke-width'], 'stroke-width', 1),
      cap: CAPS[st['stroke-linecap'] ?? ''] ?? 0,
      join: JOINS[st['stroke-linejoin'] ?? ''] ?? 0,
      miterLimit: Number.parseFloat(st['stroke-miterlimit'] ?? '4') || 4,
      evenOdd: st['fill-rule'] === 'evenodd',
      start,
      end
    })
  }

  const walk = (el: XmlElement, m: Affine6, st: Style, depth: number) => {
    for (const kid of el.children) {
      const tag = kid.name
      if (SKIP.has(tag) || tag === 'style') {
        continue
      }
      const { inh, own } = cascade(kid, st)
      if (own.display === 'none') {
        continue
      }
      const km = own.transform ? mul(m, parseSvgTransform(own.transform)) : m
      if (tag === 'g' || tag === 'a') {
        checkOwn(own, 'g')
        walk(kid, km, inh, depth)
        continue
      }
      if (tag === 'use') {
        checkOwn(own, 'use')
        if (depth > 8) {
          no('<use> nesting')
        }
        const href = kid.attrs.get('href') ?? kid.attrs.get('xlink:href') ?? ''
        const ref = href.startsWith('#') ? ids.get(href.slice(1)) : undefined
        if (!ref) {
          return no(`<use href="${href}">`)
        }
        if (ref.name === 'symbol' || ref.name === 'svg') {
          no(`<use> of <${ref.name}>`)
        }
        if (!SHAPES.has(ref.name) && ref.name !== 'g') {
          no(`<use> of <${ref.name}>`)
        }
        const um = mul(km, [
          1,
          0,
          0,
          1,
          length(kid.attrs.get('x'), 'x'),
          length(kid.attrs.get('y'), 'y')
        ])
        // The referenced element is instanced under the <use>: it
        // inherits from it.
        walk({ ...kid, children: [ref] }, um, inh, depth + 1)
        continue
      }
      if (SHAPES.has(tag)) {
        checkOwn(own, 'shape')
        shape(kid, km, inh, own)
        continue
      }
      no(`<${tag}>`)
    }
  }

  const top = cascade(root, { ...INHERITED })
  checkOwn(top.own, 'g')
  if (top.own.transform) {
    no('a transform on the root <svg>')
  }
  walk(root, ID, top.inh, 0)
  return {
    viewBox,
    align,
    slice,
    shapes,
    tape: Float64Array.from(tape.ops)
  }
}
