// Pseudo-elements: `::marker`, `::before`, `::after`.
//
// Browsers expose a pseudo-element's computed style but not its boxes, so
// this synthesises records from `getComputedStyle(el, pseudo)` plus the host
// element's measured geometry. Chrome's resolved values help: `width` /
// `height` of a pseudo that generates a block-level or atomic box are its
// used size, and `left`/`top` of an absolutely positioned one are resolved
// px, so only inline pseudos and markers are positioned from the host's
// glyphs. Text is laid out on a single line with Canvas 2D `measureText`.
//
// Everything is built in a local frame (the host's border box, or the
// absolute containing block's padding box) and mapped through its
// Placement, so pseudo content follows transforms. Called from readNode in
// tree.ts after the host's children are read; tree.ts decides where the
// items land in paint order.
//
// Chrome paints `disc` / `circle` / `square` markers as shapes, not as the
// U+2022 glyph, so those become BoxRecords with Chrome's symbol geometry
// (`ListMarker::RelativeSymbolMarkerRect` / `InlineMarginsForOutside`).
//
// Gaps: `counter()` / `counters()` / quotes / `url()` content pieces are
// dropped; `list-style-image` and `disclosure-*` markers are not drawn;
// `float`, `text-transform` and multi-line pseudo text are ignored (a
// pseudo's `transform` / `translate` / `rotate` / `scale` apply, except
// matrix3d's translation); right-to-left and vertical writing modes are laid out as
// horizontal LTR; a `position: fixed` pseudo uses the containing block of an
// absolute one.
import { blendMaterialId } from '../scene/blend'
import type { BoxRecord, Glyph, GlyphRun, Rect } from '../scene/records'
import { contextZIndex, createsStackingContext } from '../scene/stacking'
import type { Layer } from '../types'
import { parseColor } from '../util/color'
import { backgroundLayerRecords } from './backgrounds'
import { px, readBox, readOpacity, readShadows } from './styles'
import {
  type FontStyleLike,
  fontMetrics,
  graphemeClass,
  graphemes,
  langOf,
  ligaturesEnabled,
  opticalSize,
  textTransformOf,
  transformText
} from './textRuns'
import {
  applyAffine,
  boxAffine,
  composeAffine,
  type Placement,
  placementAabb,
  subPlacement
} from './transform'

/** A glyph found in the host's subtree, with its run (for its font). */
export interface GlyphRef {
  g: Glyph
  run: GlyphRun
}

export interface PseudoHost {
  el: Element
  s: CSSStyleDeclaration
  /** The host's border box. */
  place: Placement
  /** The host's content clip (its childClip). */
  clip: Rect | null
  /** Padding box of the containing block for an absolutely positioned
   * pseudo: the host's own when it is positioned / transformed. */
  cb: Placement
  boxes: boolean
  text: boolean
  alloc: () => number
}

export interface PseudoOut {
  items: (BoxRecord | GlyphRun)[]
  /** Set when the pseudo is positioned (or otherwise creates a stacking
   * context): tree.ts wraps the items in a context node. */
  context: { z: number; alpha: number; rect: Rect } | null
}

interface Insets {
  ml: number
  mr: number
  mt: number
  mb: number
  pl: number
  pr: number
  pt: number
  pb: number
  bl: number
  br: number
  bt: number
  bb: number
}

function insets(s: CSSStyleDeclaration): Insets {
  return {
    ml: px(s.marginLeft),
    mr: px(s.marginRight),
    mt: px(s.marginTop),
    mb: px(s.marginBottom),
    pl: px(s.paddingLeft),
    pr: px(s.paddingRight),
    pt: px(s.paddingTop),
    pb: px(s.paddingBottom),
    bl: px(s.borderLeftWidth),
    br: px(s.borderRightWidth),
    bt: px(s.borderTopWidth),
    bb: px(s.borderBottomWidth)
  }
}

/** A computed length in px, or null for `auto` / anything not px. */
function pxOrNull(v: string): number | null {
  if (!v.endsWith('px')) {
    return null
  }
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? n : null
}

/** Local content box of a border-box placement. */
function contentBox(s: CSSStyleDeclaration, place: Placement): Rect {
  const i = insets(s)
  return {
    x: i.bl + i.pl,
    y: i.bt + i.pt,
    width: Math.max(0, place.local.w - i.bl - i.br - i.pl - i.pr),
    height: Math.max(0, place.local.h - i.bt - i.bb - i.pt - i.pb)
  }
}

/** The padding box of a border-box placement, as its own placement. */
export function paddingPlacement(
  s: CSSStyleDeclaration,
  place: Placement
): Placement {
  const bl = px(s.borderLeftWidth)
  const bt = px(s.borderTopWidth)
  const w = place.local.w - bl - px(s.borderRightWidth)
  const h = place.local.h - bt - px(s.borderBottomWidth)
  return subPlacement(place, bl, bt, Math.max(0, w), Math.max(0, h))
}

/** Map a doc-space point into `frame`'s local coordinates. */
function docToLocal(frame: Placement, x: number, y: number): [number, number] {
  const [a, b, c, d, tx, ty] = frame.xform
  const det = a * d - b * c
  const dx = x - tx
  const dy = y - ty
  if (det === 0) {
    return [dx, dy]
  }
  return [(d * dx - c * dy) / det, (a * dy - b * dx) / det]
}

/** A glyph's line box in `frame`'s local coordinates. */
function glyphLine(
  frame: Placement,
  ref: GlyphRef
): { x: number; right: number; top: number; h: number } {
  const xf = ref.g.xform
  const [x, top] = docToLocal(frame, xf[4], xf[5])
  return { x, right: x + ref.g.local.w, top, h: ref.g.local.h }
}

function runFont(run: GlyphRun, fontSize: number): FontStyleLike {
  return {
    fontSize: `${fontSize}px`,
    fontStyle: run.italic ? 'italic' : 'normal',
    fontWeight: String(run.fontWeight),
    fontFamily: run.fontStack
  }
}

/** Baseline (frame-local y) of a reference glyph, by the same centring
 * rule the text backends apply to its line box. */
function refBaseline(frame: Placement, ref: GlyphRef): number {
  const line = glyphLine(frame, ref)
  const m = fontMetrics(runFont(ref.run, ref.g.fontSize))
  return line.top + (line.h - m.height) / 2 + m.ascent
}

/** Used line height of a style (`normal` → the font's content height). */
function lineHeight(s: CSSStyleDeclaration): number {
  return pxOrNull(s.lineHeight) ?? fontMetrics(s).height
}

// ---- content ---------------------------------------------------------

const HEX = /[0-9a-fA-F]/

/**
 * Parse a computed `content` value into its text, or null for `none` /
 * `normal`. Strings (with CSS escapes) and `attr(name)` are supported;
 * `counter()`, `counters()`, quotes keywords and `url()` contribute
 * nothing. Alt text after `/` is ignored.
 */
export function parseContent(value: string, el: Element): string | null {
  const v = value.trim()
  if (!v || v === 'none' || v === 'normal') {
    return null
  }
  let out = ''
  let i = 0
  while (i < v.length) {
    const ch = v[i] as string
    if (ch === '"' || ch === "'") {
      i++
      while (i < v.length && v[i] !== ch) {
        const c = v[i] as string
        if (c === '\\') {
          i++
          let hex = ''
          while (hex.length < 6 && i < v.length && HEX.test(v[i] as string)) {
            hex += v[i]
            i++
          }
          if (hex) {
            out += String.fromCodePoint(Number.parseInt(hex, 16) || 0xfffd)
            if (v[i] === ' ') {
              i++
            }
          } else if (i < v.length) {
            if (v[i] !== '\n') {
              out += v[i]
            }
            i++
          }
        } else {
          out += c
          i++
        }
      }
      i++ // closing quote
    } else if (ch === '/') {
      break
    } else if (/[a-zA-Z-]/.test(ch)) {
      let name = ''
      while (i < v.length && /[a-zA-Z0-9-]/.test(v[i] as string)) {
        name += v[i]
        i++
      }
      if (v[i] === '(') {
        let depth = 0
        let args = ''
        for (; i < v.length; i++) {
          const c = v[i] as string
          if (c === '(') {
            depth++
          } else if (c === ')') {
            depth--
            if (depth === 0) {
              i++
              break
            }
          }
          if (depth > 0 && !(depth === 1 && c === '(')) {
            args += c
          }
        }
        if (name === 'attr') {
          const attr = args.trim().split(/[\s,]+/)[0] ?? ''
          if (attr) {
            out += el.getAttribute(attr) ?? ''
          }
        }
      }
    } else {
      i++
    }
  }
  return out
}

// ---- text layout -----------------------------------------------------

let ctx: CanvasRenderingContext2D | null | undefined

function measureCtx(): CanvasRenderingContext2D | null {
  if (ctx === undefined) {
    ctx = document.createElement('canvas').getContext('2d')
  }
  return ctx
}

function canvasFont(s: FontStyleLike): string {
  const fontSize = Number.parseFloat(s.fontSize) || 16
  return `${s.fontStyle} ${s.fontWeight} ${fontSize}px ${s.fontFamily}`
}

interface Cell {
  text: string
  x: number
  w: number
}

interface Laid {
  cells: Cell[]
  width: number
}

const DIGIT = /^[0-9]$/

/**
 * Pen positions of each grapheme of `text` from prefix widths (so kerning
 * between them is kept). With `usedWidth` (the browser's used inline size)
 * the advances are corrected to it: `tabular` digits share the remainder
 * equally (the marker UA style is `font-variant-numeric: tabular-nums`,
 * which Canvas 2D can't set), anything else is scaled. `text` is the
 * source content; `text-transform` of `s` is applied here, before measuring.
 */
function layoutLine(
  source: string,
  s: CSSStyleDeclaration,
  el: Element,
  usedWidth: number | null,
  tabular: boolean
): Laid {
  const tt = textTransformOf(s)
  const text = transformText(source, tt, tt ? langOf(el) : undefined)
  const c = measureCtx()
  const cells: Cell[] = []
  let width = 0
  if (c) {
    c.font = canvasFont(s)
    const ls = s.letterSpacing
    const withLs = c as CanvasRenderingContext2D & { letterSpacing?: string }
    if ('letterSpacing' in withLs) {
      withLs.letterSpacing = ls && ls !== 'normal' ? ls : '0px'
    }
    let prefix = ''
    let prev = 0
    for (const g of graphemes(text)) {
      prefix += g
      const next = c.measureText(prefix).width
      cells.push({ text: g, x: prev, w: next - prev })
      prev = next
    }
    width = prev
  } else {
    const fs = Number.parseFloat(s.fontSize) || 16
    for (const g of graphemes(text)) {
      cells.push({ text: g, x: width, w: fs * 0.55 })
      width += fs * 0.55
    }
  }
  if (usedWidth === null || width <= 0 || Math.abs(usedWidth - width) < 0.01) {
    return { cells, width }
  }
  const digits = cells.filter((x) => DIGIT.test(x.text))
  if (tabular && digits.length > 0) {
    const other = cells.reduce((a, x) => a + (DIGIT.test(x.text) ? 0 : x.w), 0)
    const dw = (usedWidth - other) / digits.length
    let x = 0
    for (const cell of cells) {
      if (DIGIT.test(cell.text)) {
        // Tabular figures keep the proportional outline centred in the
        // wider advance.
        cell.x = x + (dw - cell.w) / 2
        x += dw
      } else {
        cell.x = x
        x += cell.w
      }
    }
  } else {
    const k = usedWidth / width
    for (const cell of cells) {
      cell.x *= k
      cell.w *= k
    }
  }
  return { cells, width: usedWidth }
}

/** A GlyphRun for laid-out text whose pen starts at frame-local
 * (x, baseline). Whitespace graphemes advance but emit no glyph. */
function buildRun(
  laid: Laid,
  s: CSSStyleDeclaration,
  frame: Placement,
  x: number,
  baseline: number,
  clip: Rect | null,
  alloc: () => number
): GlyphRun | null {
  const m = fontMetrics(s)
  const fontSize = Number.parseFloat(s.fontSize) || 16
  const color = parseColor(s.color)
  const glyphs: Glyph[] = []
  let index = 0
  for (const cell of laid.cells) {
    if (cell.text.trim().length > 0 && cell.w > 0) {
      const p = subPlacement(
        frame,
        x + cell.x,
        baseline - m.ascent,
        cell.w,
        m.height
      )
      glyphs.push({
        index,
        rect: placementAabb(p),
        xform: p.xform,
        local: p.local,
        glyphId: cell.text.codePointAt(0) ?? 0,
        text: cell.text,
        ...graphemeClass(cell.text),
        fontId: 0,
        fontSize,
        color,
        offset: { x: 0, y: 0 }
      })
    }
    index++
  }
  if (glyphs.length === 0) {
    return null
  }
  const italic = s.fontStyle === 'italic' || s.fontStyle.startsWith('oblique')
  return {
    kind: 'text',
    id: alloc(),
    fontId: 0,
    fontFamily: (s.fontFamily.split(',')[0] ?? '')
      .trim()
      .replace(/^['"]|['"]$/g, ''),
    fontStack: s.fontFamily,
    fontWeight: Number.parseInt(s.fontWeight, 10) || 400,
    opsz: opticalSize(s, fontSize),
    italic,
    ligatures: ligaturesEnabled(s),
    color,
    glyphs,
    opacity: 1,
    z: 0,
    clip
  }
}

/** Background/border/shadow records for a pseudo box at frame-local
 * (x, y, w, h), in paint order (shadows under the box). */
function boxRecords(
  s: CSSStyleDeclaration,
  frame: Placement,
  x: number,
  y: number,
  w: number,
  h: number,
  clip: Rect | null,
  alloc: () => number
): BoxRecord[] {
  if (w <= 0 || h <= 0) {
    return []
  }
  const place = subPlacement(frame, x, y, w, h)
  const rect = placementAabb(place)
  const out = readShadows(s, rect, place, alloc)
  const box = readBox(s, rect, alloc(), place)
  if (box) {
    out.push(box)
  }
  // Gradient layers above the bottom one (url layers aren't mirrored for
  // pseudo-elements).
  for (const r of backgroundLayerRecords(
    box ?? undefined,
    s,
    place,
    rect,
    clip,
    alloc,
    PSEUDO_LAYERS,
    () => null
  )) {
    if (r.kind === 'box') {
      out.push(r)
    }
  }
  for (const r of out) {
    r.clip = clip
  }
  return out
}

const PSEUDO_LAYERS: ReadonlySet<Layer> = new Set(['boxes'])

// ---- ::marker --------------------------------------------------------

/** Per-read cache: list element → ordinal of each list-item child. */
export type OrdinalCache = Map<Element, Map<Element, number>>

function ordinal(li: Element, cache: OrdinalCache): number {
  const list = li.parentElement
  if (!list) {
    return 1
  }
  let map = cache.get(list)
  if (!map) {
    map = new Map()
    const items: Element[] = []
    for (const c of list.children) {
      if (getComputedStyle(c).display === 'list-item') {
        items.push(c)
      }
    }
    const isOl = list.tagName === 'OL'
    const reversed = isOl && (list as HTMLOListElement).reversed
    const startAttr = isOl ? list.getAttribute('start') : null
    const parsed =
      startAttr === null ? Number.NaN : Number.parseInt(startAttr, 10)
    const start = Number.isFinite(parsed) ? parsed : reversed ? items.length : 1
    const step = reversed ? -1 : 1
    let n: number | null = null
    for (const c of items) {
      const v = Number.parseInt(c.getAttribute('value') ?? '', 10)
      n = Number.isFinite(v) ? v : n === null ? start : n + step
      map.set(c, n)
    }
    cache.set(list, map)
  }
  return map.get(li) ?? 1
}

function alpha(n: number, upper: boolean): string {
  if (n < 1) {
    return String(n)
  }
  let s = ''
  let k = n
  while (k > 0) {
    k--
    s = String.fromCharCode((upper ? 65 : 97) + (k % 26)) + s
    k = Math.floor(k / 26)
  }
  return s
}

const ROMAN: [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i']
]

function roman(n: number, upper: boolean): string {
  if (n < 1 || n > 3999) {
    return String(n)
  }
  let s = ''
  let k = n
  for (const [v, r] of ROMAN) {
    while (k >= v) {
      s += r
      k -= v
    }
  }
  return upper ? s.toUpperCase() : s
}

/** Marker text (with Chrome's ". " suffix) for a counter style, or null
 * when the style isn't supported. */
function counterText(type: string, n: number): string | null {
  switch (type) {
    case 'decimal':
      return `${n}. `
    case 'decimal-leading-zero':
      return `${n >= 0 && n < 10 ? `0${n}` : n > -10 && n < 0 ? `-0${-n}` : n}. `
    case 'lower-alpha':
    case 'lower-latin':
      return `${alpha(n, false)}. `
    case 'upper-alpha':
    case 'upper-latin':
      return `${alpha(n, true)}. `
    case 'lower-roman':
      return `${roman(n, false)}. `
    case 'upper-roman':
      return `${roman(n, true)}. `
    default:
      return null
  }
}

/** Chrome's `kCMarkerPaddingPx`: gap after an outside symbol marker. */
const MARKER_PADDING = 7

/**
 * `::marker` of a `display: list-item` host, or null. `first` is the
 * first glyph in the host's subtree (its first line box), if any.
 */
export function readMarker(
  host: PseudoHost,
  first: GlyphRef | null,
  cache: OrdinalCache
): PseudoOut | null {
  const { el, s, place, clip, alloc } = host
  const ms = getComputedStyle(el, '::marker')
  if (ms.visibility !== 'visible' || ms.display === 'none') {
    return null
  }
  const content = parseContent(ms.content, el)
  const type = s.listStyleType
  const outside = s.listStylePosition !== 'inside'
  const cbox = contentBox(s, place)
  const m = fontMetrics(ms)
  const baseline = first
    ? refBaseline(place, first)
    : cbox.y + (lineHeight(s) - m.height) / 2 + m.ascent

  const symbol =
    content === null &&
    (type === 'disc' || type === 'circle' || type === 'square')
  if (symbol) {
    if (!host.boxes) {
      return null
    }
    // ListMarker::RelativeSymbolMarkerRect / InlineMarginsForOutside, with
    // Chrome's integer font ascent.
    const ascent = Math.round(m.ascent)
    const off = Math.floor((ascent * 2) / 3)
    const size = Math.floor((off + 1) / 2)
    const x = outside ? cbox.x - off - MARKER_PADDING : cbox.x
    const y = baseline - ascent + Math.floor((3 * (ascent - off)) / 2)
    const color = parseColor(ms.color)
    // Chrome pixel-snaps the symbol rect in device space; untransformed,
    // that is the document grid.
    const [a, b, c, d, tx, ty] = place.xform
    const flat = a === 1 && b === 0 && c === 0 && d === 1
    const sx = flat ? Math.round(tx + x) - tx : Math.round(x)
    const sy = flat ? Math.round(ty + y) - ty : Math.round(y)
    const round = type !== 'square'
    const r = round ? size / 2 : 0
    const stroke = type === 'circle'
    const grow = stroke ? 0.5 : 0
    const p = subPlacement(
      place,
      sx - grow,
      sy - grow,
      size + 2 * grow,
      size + 2 * grow
    )
    const rr = r + grow
    const box: BoxRecord = {
      kind: 'box',
      id: alloc(),
      rect: placementAabb(p),
      xform: p.xform,
      local: p.local,
      radius: [rr, rr, rr, rr],
      fill: stroke ? { r: 0, g: 0, b: 0, a: 0 } : color,
      gradient: null,
      border: stroke
        ? {
            widths: [1, 1, 1, 1],
            colors: [color, color, color, color],
            styles: [0, 0, 0, 0]
          }
        : null,
      opacity: 1,
      z: 0,
      clip
    }
    return { items: [box], context: null }
  }

  if (!host.text) {
    return null
  }
  let text = content
  if (text === null) {
    const quoted = /^["']/.test(type) ? parseContent(type, el) : null
    text = quoted ?? counterText(type, ordinal(el, cache))
  }
  if (!text) {
    return null
  }
  const used = pxOrNull(ms.width)
  const tabular = ms.fontVariantNumeric.includes('tabular-nums')
  const laid = layoutLine(text, ms, el, used, tabular)
  const x = outside ? cbox.x - laid.width : cbox.x
  const run = buildRun(laid, ms, place, x, baseline, clip, alloc)
  return run ? { items: [run], context: null } : null
}

// ---- ::before / ::after ----------------------------------------------

const BLOCKISH = new Set([
  'block',
  'flex',
  'grid',
  'list-item',
  'table',
  'flow-root'
])

/**
 * `::before` / `::after` of `host`, or null when it generates nothing.
 * `anchor` is the host subtree's first (before) / last (after) glyph, used
 * to place an inline pseudo on the host's first / last line.
 */
export function readBeforeAfter(
  host: PseudoHost,
  which: '::before' | '::after',
  anchor: GlyphRef | null
): PseudoOut | null {
  const { el, s, place, clip, alloc } = host
  const ps = getComputedStyle(el, which)
  const text = parseContent(ps.content, el)
  if (text === null) {
    return null
  }
  const display = ps.display
  if (display === 'none' || display === 'contents') {
    return null
  }
  if (ps.visibility !== 'visible') {
    return null
  }

  const i = insets(ps)
  const padX = i.pl + i.pr + i.bl + i.br
  const padY = i.pt + i.pb + i.bt + i.bb
  const borderBox = ps.boxSizing === 'border-box'
  const usedW = pxOrNull(ps.width)
  const usedH = pxOrNull(ps.height)
  const cwUsed = usedW === null ? null : borderBox ? usedW - padX : usedW
  const chUsed = usedH === null ? null : borderBox ? usedH - padY : usedH
  const m = fontMetrics(ps)
  const lh = lineHeight(ps)
  const laid = layoutLine(text, ps, el, null, false)
  const tw = laid.width
  const hasText = laid.cells.some((c) => c.text.trim().length > 0)
  const cbox = contentBox(s, place)
  const before = which === '::before'
  const pos = ps.position
  const positioned = pos === 'absolute' || pos === 'fixed'
  const isFlex =
    display === 'flex' ||
    display === 'inline-flex' ||
    display === 'grid' ||
    display === 'inline-grid'

  let frame = place
  let bx: number
  let by: number
  let cw: number
  let ch: number
  /** Frame-local baseline for inline text, or null → from the box. */
  let inlineBaseline: number | null = null

  if (positioned) {
    frame = host.cb
    const cbW = frame.local.w
    const cbH = frame.local.h
    const left = pxOrNull(ps.left)
    const right = pxOrNull(ps.right)
    const top = pxOrNull(ps.top)
    const bottom = pxOrNull(ps.bottom)
    cw =
      cwUsed ??
      (left !== null && right !== null
        ? cbW - left - right - i.ml - i.mr - padX
        : hasText
          ? tw
          : 0)
    ch =
      chUsed ??
      (top !== null && bottom !== null
        ? cbH - top - bottom - i.mt - i.mb - padY
        : hasText
          ? lh
          : 0)
    cw = Math.max(0, cw)
    ch = Math.max(0, ch)
    const bw = cw + padX
    const bh = ch + padY
    // Static position: the host's content-box start (before) or end
    // (after, approximated), mapped into the containing block's frame.
    const sx = before ? cbox.x : cbox.x + cbox.width - bw
    const sy = before ? cbox.y : cbox.y + cbox.height - bh
    const [dx, dy] = applyAffine(place.xform, sx, sy)
    const [stx, sty] = docToLocal(frame, dx, dy)
    bx =
      left !== null
        ? left + i.ml
        : right !== null
          ? cbW - right - i.mr - bw
          : stx
    by =
      top !== null
        ? top + i.mt
        : bottom !== null
          ? cbH - bottom - i.mb - bh
          : sty
  } else if (BLOCKISH.has(display)) {
    cw = Math.max(0, cwUsed ?? cbox.width - i.ml - i.mr - padX)
    ch = Math.max(0, chUsed ?? (hasText ? lh : 0))
    bx = cbox.x + i.ml
    by = before ? cbox.y + i.mt : cbox.y + cbox.height - (ch + padY) - i.mb
  } else {
    // Inline / inline-block: on the host's first / last line.
    cw = Math.max(0, cwUsed ?? tw)
    const inlineBlock = display !== 'inline'
    const baseline = anchor
      ? refBaseline(place, anchor)
      : cbox.y + (lh - m.height) / 2 + m.ascent
    const bw = cw + padX
    if (anchor) {
      const line = glyphLine(place, anchor)
      bx = before ? line.x - i.mr - bw : line.right + i.ml
    } else {
      bx = cbox.x + i.ml
    }
    if (inlineBlock) {
      ch = Math.max(0, chUsed ?? (hasText ? lh : 0))
      by = hasText
        ? baseline - m.ascent - (lh - m.height) / 2 - i.pt - i.bt
        : baseline - i.mb - (ch + padY)
    } else {
      // A non-atomic inline's background covers its content area.
      ch = m.height
      by = baseline - m.ascent - i.pt - i.bt
    }
    inlineBaseline = baseline
  }

  const bw = cw + padX
  const bh = ch + padY
  // The pseudo's own transform, about its border box (CSS doesn't
  // transform non-atomic inline boxes). Scaled to nothing, it paints
  // nothing (a `scale: 0 1` wipe at rest).
  if (positioned || display !== 'inline') {
    const a = boxAffine(ps, bx, by, bw, bh)
    if (a) {
      if (Math.abs(a[0] * a[3] - a[1] * a[2]) < 1e-6) {
        return null
      }
      frame = { xform: composeAffine(frame.xform, a), local: frame.local }
    }
  }
  const items: (BoxRecord | GlyphRun)[] = []
  if (host.boxes) {
    items.push(...boxRecords(ps, frame, bx, by, bw, bh, clip, alloc))
  }
  if (host.text && hasText) {
    let ax = 0
    const ta = ps.textAlign
    const justifyCenter = isFlex && ps.justifyContent === 'center'
    if (inlineBaseline === null) {
      if (ta === 'center' || justifyCenter) {
        ax = (cw - tw) / 2
      } else if (ta === 'right' || ta === 'end') {
        ax = cw - tw
      }
    }
    let baseline = inlineBaseline
    if (baseline === null) {
      const centre = isFlex && ps.alignItems === 'center'
      const lineTop = by + i.bt + i.pt + (centre ? (ch - lh) / 2 : 0)
      baseline = lineTop + (lh - m.height) / 2 + m.ascent
    }
    const run = buildRun(
      laid,
      ps,
      frame,
      bx + i.bl + i.pl + ax,
      baseline,
      clip,
      alloc
    )
    if (run) {
      items.push(run)
    }
  }
  if (items.length === 0) {
    return null
  }
  const blend = blendMaterialId(ps.mixBlendMode)
  if (blend !== undefined) {
    for (const it of items) {
      it.material = blend
      if (it.kind === 'text') {
        for (const d of it.decorations ?? []) {
          d.material = blend
        }
      }
    }
  }
  const context = createsStackingContext(ps, display !== 'inline')
    ? {
        z: contextZIndex(ps),
        alpha: Math.max(0, readOpacity(ps)),
        rect: placementAabb(subPlacement(frame, bx, by, bw, bh))
      }
    : null
  return { items, context }
}
