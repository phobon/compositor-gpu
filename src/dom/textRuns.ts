import type { Glyph, GlyphRun, Rect, RGBA, TextShadow } from '../scene/records'
import { isColorGrapheme } from '../text/glyphAtlas'
import { parseColor } from '../util/color'
import { splitTopLevel } from '../util/css'
import { toDocRect } from './styles'

/** Read text by line fragment or by whitespace-free chunk and split it
 * into graphemes with Canvas 2D advances (see `readTextNode`). False reads
 * every grapheme with its own Range. */
export const FAST_TEXT_READ = true

/** Text-read counts since the last `beginTextRead` (`stats().textRead`). */
export interface TextReadStats {
  /** Graphemes given a glyph. */
  graphemes: number
  /** Of those, read with their own Range (not split from a chunk). */
  perGrapheme: number
  /** Range layout queries issued. */
  ranges: number
}

export const textReadStats: TextReadStats = {
  graphemes: 0,
  perGrapheme: 0,
  ranges: 0
}

/** Start a read pass: zero the counts and forget the per-style fields
 * (`runStyle`), which only hold within one synchronous pass. */
export function beginTextRead(): void {
  textReadStats.graphemes = 0
  textReadStats.perGrapheme = 0
  textReadStats.ranges = 0
  runStyles = new WeakMap()
}

// Grapheme segmenter (browser-native). Falls back to Array.from for old envs.
const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

// Segmentation is pure and text nodes repeat across reads, so cache it.
// Bounded: cleared when it grows past CACHE_MAX entries.
const CACHE_MAX = 4096
const graphemeCache = new Map<string, string[]>()

/** Grapheme clusters of `text` (cached, shared result: don't mutate). */
export function graphemes(text: string): string[] {
  const hit = graphemeCache.get(text)
  if (hit) {
    return hit
  }
  const out = segmenter
    ? Array.from(segmenter.segment(text), (s) => s.segment)
    : Array.from(text)
  if (graphemeCache.size >= CACHE_MAX) {
    graphemeCache.clear()
  }
  graphemeCache.set(text, out)
  return out
}

/** A grapheme's fallback classification (see Glyph.colour/codePoints). */
export interface GraphemeClass {
  colour: boolean
  codePoints: number
}

const classCache = new Map<string, GraphemeClass>()

/** U+FE00–FE0F and U+E0100–E01EF. */
function isVariationSelector(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)
}

/** Classify a grapheme once for the text backend: colour/emoji, and its
 * code-point count without variation selectors. Cached (shared result). */
export function graphemeClass(cell: string): GraphemeClass {
  const hit = classCache.get(cell)
  if (hit) {
    return hit
  }
  let codePoints = 0
  for (const ch of cell) {
    if (!isVariationSelector(ch.codePointAt(0) ?? 0)) {
      codePoints++
    }
  }
  const out = { colour: isColorGrapheme(cell), codePoints }
  if (classCache.size >= CACHE_MAX) {
    classCache.clear()
  }
  classCache.set(cell, out)
  return out
}

/**
 * Extract per-glyph geometry from a single text node by ranging over each
 * grapheme and reading its client rect. This inherits the browser's shaping,
 * kerning, bidi and line breaks — the whole point of "replicating the HTML
 * text". Chrome splits a ligature's advance across its graphemes' rects;
 * the Slug backend merges those back into the ligature glyph.
 *
 * With `fast` (FAST_TEXT_READ, off under a transform) the node is read
 * with one `getClientRects()` and its lines are split into graphemes from
 * Canvas 2D advances (`readLines`); failing that, each whitespace-free
 * chunk is read with one Range and split the same way (`readChunk`);
 * failing that, per grapheme. A split is used only when the canvas widths
 * match the browser's rects, so the output matches the per-grapheme read
 * to within 0.05px.
 *
 * NOTE: each Range rect is a forced layout read. The caller MUST batch all
 * of these before any GPU write in a frame (see observer/sync).
 *
 * `s` is the computed style of the text node's parent element.
 *
 * `glyphId` is set to the grapheme's first code point as a placeholder; the
 * Slug font stage remaps it through the font cmap to a real glyph index.
 * Both it and `text` come from the grapheme after `text-transform`; the
 * rect is the source grapheme's, which is where the browser paints it.
 *
 * `letter-spacing` needs no correction here: Chrome adds it to each
 * grapheme's advance on its right-hand side (in RTL runs too; see the
 * playground's `texttransform` section), so the rect widens but its left
 * edge stays at the pen origin, and both the Slug ink box (glyph bbox from
 * the origin) and atlas quads are placed from that edge, not stretched to
 * the rect width.
 */
export function readTextNode(
  node: Text,
  s: CSSStyleDeclaration,
  runId: number,
  fontId: number,
  startIndex: number,
  fast = FAST_TEXT_READ
): GlyphRun | null {
  const text = node.nodeValue
  if (!text?.trim()) {
    return null
  }
  const rs = runStyle(s)
  // Hidden text paints nothing (and so no decorations); a descendant
  // element can still set `visibility: visible` for its own text.
  if (!rs.visible) {
    return null
  }
  const { color, fontSize, tt } = rs
  const glyphs: Glyph[] = []
  const lang = tt ? langOf(node.parentElement) : undefined
  // The two source graphemes before the current one (capitalize context).
  let b1 = ''
  let b2 = ''

  const cells = graphemes(text)
  const n = cells.length
  // Source offset and displayed (text-transformed) form of each cell. The
  // browser paints the transformed text in the source grapheme's rect; a
  // transform that adds code points (ß -> SS) makes the cell a
  // multi-code-point cluster, which the fallback atlas draws.
  const offs = new Array<number>(n)
  const shown = new Array<string>(n)
  let off = 0
  for (let i = 0; i < n; i++) {
    const cell = cells[i] ?? ''
    offs[i] = off
    shown[i] = tt ? transformCell(cell, b1, b2, tt, lang) : cell
    b2 = b1
    b1 = cell
    off += cell.length
  }
  const push = (i: number, rect: Rect): void => {
    const cell = shown[i] ?? ''
    const cls = graphemeClass(cell)
    glyphs.push({
      index: startIndex + i,
      rect,
      // Untransformed; the reader re-derives these under a transform.
      xform: [1, 0, 0, 1, rect.x, rect.y],
      local: { w: rect.width, h: rect.height },
      glyphId: cell.codePointAt(0) ?? 0,
      text: cell,
      colour: cls.colour,
      codePoints: cls.codePoints,
      fontId,
      fontSize,
      color,
      offset: { x: 0, y: 0 }
    })
  }
  const range = document.createRange()
  const split = fast ? splitSetup(s) : null
  const stats = textReadStats
  const lined =
    split?.lines === true &&
    readLines(node, range, split, cells, offs, shown, push)
  for (let i = lined ? n : 0; i < n; ) {
    if (isBlank(cells[i] ?? '')) {
      i++
      continue
    }
    let j = i + 1
    while (j < n && !isBlank(cells[j] ?? '')) {
      j++
    }
    const done =
      split !== null &&
      j - i > 1 &&
      readChunk(node, range, split, offs, shown, i, j, push)
    if (!done) {
      for (let k = i; k < j; k++) {
        const start = offs[k] ?? 0
        range.setStart(node, start)
        range.setEnd(node, start + (cells[k] ?? '').length)
        const r = range.getBoundingClientRect()
        stats.ranges++
        if (r.width > 0 && r.height > 0) {
          push(k, toDocRect(r))
          stats.perGrapheme++
        }
      }
    }
    i = j
  }
  range.detach?.()
  if (glyphs.length === 0) {
    return null
  }
  stats.graphemes += glyphs.length
  return {
    kind: 'text',
    id: runId,
    fontId,
    fontFamily: rs.fontFamily,
    fontStack: rs.fontStack,
    fontWeight: rs.fontWeight,
    opsz: rs.opsz,
    italic: rs.italic,
    ligatures: rs.ligatures,
    color,
    glyphs,
    textShadows: rs.textShadows,
    opacity: 1,
    z: 0
  }
}

/** The run-level fields `readTextNode` derives from a computed style. */
interface RunStyle {
  visible: boolean
  color: RGBA
  fontSize: number
  fontFamily: string
  fontStack: string
  fontWeight: number
  italic: boolean
  opsz: number | null
  tt: TextTransform | null
  ligatures: boolean
  letterSpacing: number
  textShadows: TextShadow[]
  /** Canvas font shorthand: style, weight, size, family. */
  font: string
  /** `readSplitSetup`, read on first use. */
  split?: SplitSetup | null
}

// Per read pass (see beginTextRead): an element's text nodes share its
// computed style object, and the style can't change within a pass.
let runStyles = new WeakMap<CSSStyleDeclaration, RunStyle>()

function runStyle(s: CSSStyleDeclaration): RunStyle {
  const hit = runStyles.get(s)
  if (hit) {
    return hit
  }
  const size = s.fontSize
  const fontSize = Number.parseFloat(size) || 16
  const fontStyle = s.fontStyle
  const weight = s.fontWeight
  const family = s.fontFamily
  const out: RunStyle = {
    visible: s.visibility === 'visible',
    color: parseColor(s.color),
    fontSize,
    fontFamily: (family.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, ''),
    fontStack: family,
    fontWeight: Number.parseInt(weight, 10) || 400,
    italic: fontStyle === 'italic' || fontStyle.startsWith('oblique'),
    opsz: opticalSize(s, fontSize),
    tt: textTransformOf(s),
    ligatures: ligaturesEnabled(s),
    letterSpacing: Number.parseFloat(s.letterSpacing) || 0,
    textShadows: readTextShadows(s.textShadow, s.color),
    font: `${fontStyle} ${weight} ${size} ${family}`
  }
  runStyles.set(s, out)
  return out
}

/** Whitespace cells get no glyph and delimit chunks. */
function isBlank(cell: string): boolean {
  return cell.trim().length === 0
}

/** Canvas 2D state that reproduces an element's text advances. */
interface SplitSetup {
  ctx: CanvasRenderingContext2D
  font: string
  kerning: CanvasFontKerning
  /** Suffix widths and width-check record for this font. */
  cache: SplitFont
  /** Measure with ZWNJ between graphemes (ligatures off in the DOM). */
  noLiga: boolean
  letterSpacing: number
  /** A chunk rect taller than this spans lines (1.5x the content height). */
  maxHeight: number
  /** Text is shown untransformed, so a chunk is a substring of the node. */
  plain: boolean
  /** Whitespace collapses and lines aren't justified (`readLines`). */
  lines: boolean
  /** Advance of a collapsed space: canvas width plus letter- and
   * word-spacing. */
  space: number
}

/** `readSplitSetup`, once per style object per read pass. */
function splitSetup(s: CSSStyleDeclaration): SplitSetup | null {
  const rs = runStyle(s)
  if (rs.split === undefined) {
    rs.split = readSplitSetup(s, rs)
  }
  return rs.split
}

/**
 * The Canvas 2D setup for splitting `s`'s text, or null when the canvas
 * can't be expected to reproduce the browser's advances: non-LTR or
 * vertical text, and font properties the canvas `font` shorthand can't
 * carry (feature/variation settings, variant caps/numeric/east-asian,
 * non-normal stretch, oblique angles, font-size-adjust, text-rendering).
 * The width checks back this up.
 */
function readSplitSetup(
  s: CSSStyleDeclaration,
  rs: RunStyle
): SplitSetup | null {
  // The computed `font` shorthand is empty unless every font longhand it
  // resets (kerning, variants, feature/variation settings, size-adjust,
  // optical sizing) is initial, which saves reading them one by one.
  const initial = s.font !== ''
  if (
    s.direction !== 'ltr' ||
    s.writingMode !== 'horizontal-tb' ||
    s.fontVariantCaps !== 'normal' ||
    (s.fontStretch !== '100%' && s.fontStretch !== 'normal') ||
    (rs.italic && s.fontStyle !== 'italic') ||
    s.textRendering !== 'auto'
  ) {
    return null
  }
  if (
    !initial &&
    (s.fontFeatureSettings !== 'normal' ||
      s.fontVariationSettings !== 'normal' ||
      s.fontVariantNumeric !== 'normal' ||
      s.fontVariantEastAsian !== 'normal' ||
      (s.fontSizeAdjust ?? 'none') !== 'none')
  ) {
    return null
  }
  const ctx = ensureMeasureCtx()
  if (!ctx) {
    return null
  }
  const { letterSpacing, font } = rs
  const kerning = (initial ? 'auto' : s.fontKerning) as CanvasFontKerning
  const noLiga = !rs.ligatures
  const key = `${font}|${kerning}|${noLiga ? 0 : 1}`
  let cache = splitCache.get(key)
  if (!cache) {
    if (splitCache.size >= SPLIT_FONTS_MAX) {
      splitCache.clear()
    }
    cache = { widths: new Map(), hits: 0, misses: 0 }
    splitCache.set(key, cache)
  }
  // A font whose chunks never match the canvas (e.g. an opsz axis under
  // `font-optical-sizing: none`, which the canvas shorthand resets to
  // auto) would cost an extra Range read per chunk.
  if (cache.hits === 0 && cache.misses >= SPLIT_GIVE_UP) {
    return null
  }
  if (cache.space === undefined) {
    ctx.font = font
    ctx.fontKerning = kerning
    cache.space = ctx.measureText(' ').width
  }
  const collapse =
    (s as unknown as { whiteSpaceCollapse?: string }).whiteSpaceCollapse ??
    (s.whiteSpace === 'normal' || s.whiteSpace === 'nowrap' ? 'collapse' : '')
  const lastAlign =
    (s as unknown as { textAlignLast?: string }).textAlignLast ?? ''
  return {
    ctx,
    font,
    kerning,
    cache,
    noLiga,
    letterSpacing,
    maxHeight: metricsFor(font, rs.fontSize).height * 1.5,
    plain: rs.tt === null,
    lines:
      collapse === 'collapse' &&
      s.textAlign !== 'justify' &&
      lastAlign !== 'justify',
    space: cache.space + letterSpacing + (Number.parseFloat(s.wordSpacing) || 0)
  }
}

// Code points whose advances Canvas 2D reproduces with the same shaping:
// Latin, Greek, Cyrillic (with combining marks), Latin/Greek extended,
// dashes/quotes/punctuation, currency, letterlike, arrows, math. Excludes
// soft hyphen, zero-width and bidi controls, RTL and complex scripts, emoji.
const SPLIT_SAFE =
  /^[!-~\u00a1-\u00ac\u00ae-\u058f\u1e00-\u1fff\u2010-\u2027\u2030-\u205e\u20a0-\u20c0\u2100-\u22ff]+$/
// Common Latin ligature starts (liga/clig in most text faces). A ligature
// splits its advance evenly across its graphemes' rects, which canvas
// prefix/suffix widths don't reproduce, so these chunks read per grapheme
// when ligatures are on.
const LIGA_CANDIDATE = /f[fijlt]/
const ZWNJ = String.fromCharCode(0x200c)
/** Max |DOM chunk width - canvas width| (px) for the canvas split. */
const SPLIT_TOLERANCE = 0.05
const SPLIT_CACHE_MAX = 16384
const SPLIT_FONTS_MAX = 256
/** Width-check failures, with no success, after which a font stops being
 * split. */
const SPLIT_GIVE_UP = 8

interface SplitFont {
  /** Per chunk string: the canvas width of each suffix, from grapheme k to
   * the end (index m is 0), without letter-spacing. A chunk's graphemes
   * are those of its string (the unsafe code points that segment by
   * context are never split). */
  widths: Map<string, Float64Array>
  /** Chunks that passed / failed the width check. */
  hits: number
  misses: number
  /** Canvas width of U+0020. */
  space?: number
}

/** Per setup (font, kerning, ligature mode). */
const splitCache = new Map<string, SplitFont>()

function suffixWidths(split: SplitSetup, joined: string): Float64Array {
  const cache = split.cache.widths
  const hit = cache.get(joined)
  if (hit) {
    return hit
  }
  const cells = graphemes(joined)
  const sep = split.noLiga ? ZWNJ : ''
  const { ctx } = split
  ctx.font = split.font
  ctx.fontKerning = split.kerning
  const m = cells.length
  const out = new Float64Array(m + 1)
  for (let k = m - 1; k >= 0; k--) {
    out[k] = ctx.measureText(cells.slice(k).join(sep)).width
  }
  if (cache.size >= SPLIT_CACHE_MAX) {
    cache.clear()
  }
  cache.set(joined, out)
  return out
}

/** Collapsible whitespace (a run renders as at most one space). */
const COLLAPSIBLE = /^[ \t\n\r\f]+$/

/**
 * Read the whole node with one `getClientRects()` (a rect per line
 * fragment) and place every chunk from canvas widths: each whitespace run
 * between chunks is one collapsed space (`split.space`), with no width at
 * a soft wrap, and a line ends where the running width matches its rect.
 * The node's leading and trailing whitespace may or may not render; when
 * both readings fit a line, one more Range measures the leading run.
 * Chunks are split into graphemes as in
 * `readChunk`; chunks with a ligature candidate get a Range per grapheme.
 * Returns false, having pushed nothing, when any chunk has unsafe code
 * points or non-collapsible whitespace, or the widths don't account for
 * every rect (a line broken inside a chunk, bidi fragments, a style the
 * canvas doesn't reproduce); the caller then reads chunk by chunk.
 */
function readLines(
  node: Text,
  range: Range,
  split: SplitSetup,
  cells: string[],
  offs: number[],
  shown: string[],
  push: (i: number, rect: Rect) => void
): boolean {
  const n = cells.length
  const text = node.nodeValue ?? ''
  const starts: number[] = []
  const ends: number[] = []
  for (let i = 0; i < n; ) {
    if (isBlank(cells[i] ?? '')) {
      if (!COLLAPSIBLE.test(cells[i] ?? '')) {
        return false
      }
      i++
      continue
    }
    let j = i + 1
    while (j < n && !isBlank(cells[j] ?? '')) {
      j++
    }
    starts.push(i)
    ends.push(j)
    i = j
  }
  const count = starts.length
  const widths: Float64Array[] = []
  const liga: boolean[] = []
  const ls = split.letterSpacing
  for (let c = 0; c < count; c++) {
    const i = starts[c] ?? 0
    const j = ends[c] ?? 0
    const joined = split.plain
      ? text.slice(offs[i] ?? 0, j < n ? (offs[j] ?? 0) : text.length)
      : shown.slice(i, j).join('')
    if (!SPLIT_SAFE.test(joined)) {
      return false
    }
    const suf = suffixWidths(split, joined)
    if (suf.length !== j - i + 1) {
      return false
    }
    widths.push(suf)
    liga.push(!split.noLiga && LIGA_CANDIDATE.test(joined))
  }
  range.selectNodeContents(node)
  const rects = range.getClientRects()
  textReadStats.ranges++
  const sp = split.space
  const width = (c: number): number =>
    (widths[c]?.[0] ?? 0) + ls * ((ends[c] ?? 0) - (starts[c] ?? 0))
  // Per chunk: its line's rect and its x offset in it.
  const lineOf: DOMRect[] = []
  const xOf: number[] = []
  // The last chunk on a line of width `w` that starts with chunk `c` at
  // `lead`, or -1. A space before a soft wrap has no width; the node's
  // trailing whitespace renders as a space when the line goes on.
  const fit = (c: number, lead: number, w: number): number => {
    let x = lead
    for (let cc = c; cc < count; cc++) {
      xOf[cc] = x
      x += width(cc)
      if (Math.abs(x - w) <= SPLIT_TOLERANCE) {
        return cc
      }
      const trail = cc === count - 1 && (ends[cc] ?? 0) < n
      if (trail && Math.abs(x + sp - w) <= SPLIT_TOLERANCE) {
        return cc
      }
      if (x > w) {
        return -1
      }
      x += sp
    }
    return -1
  }
  let c = 0
  // The node's leading whitespace is still unplaced.
  let leading = (starts[0] ?? 0) > 0
  for (let k = 0; k < rects.length; k++) {
    const r = rects[k]
    if (!r || r.width <= 0) {
      continue
    }
    if (c >= count || r.height > split.maxHeight) {
      return false
    }
    let matched = fit(c, 0, r.width)
    // Only the node's first fragment can open with a rendered space.
    if (leading) {
      leading = false
      const spaced = fit(0, sp, r.width)
      if (matched >= 0 && spaced >= 0) {
        // A leading space or a trailing one: measure the leading run.
        range.setStart(node, 0)
        range.setEnd(node, offs[starts[0] ?? 0] ?? 0)
        const lead = range.getBoundingClientRect().width
        textReadStats.ranges++
        matched = fit(0, lead > sp / 2 ? sp : 0, r.width)
      } else if (spaced >= 0) {
        matched = spaced
      } else if (matched >= 0) {
        matched = fit(0, 0, r.width)
      } else if (Math.abs(r.width - sp) <= SPLIT_TOLERANCE) {
        // A lone leading space that ended the line before.
        continue
      }
    }
    if (matched < 0) {
      split.cache.misses++
      return false
    }
    for (let cc = c; cc <= matched; cc++) {
      lineOf[cc] = r
    }
    c = matched + 1
  }
  if (c !== count) {
    split.cache.misses++
    return false
  }
  split.cache.hits++
  let baseOf: DOMRect | null = null
  let base: Rect = { x: 0, y: 0, width: 0, height: 0 }
  for (let c = 0; c < count; c++) {
    const i = starts[c] ?? 0
    const m = (ends[c] ?? 0) - i
    const r = lineOf[c]
    if (!r) {
      continue
    }
    if (liga[c]) {
      for (let k = i; k < i + m; k++) {
        const start = offs[k] ?? 0
        range.setStart(node, start)
        range.setEnd(node, start + (cells[k] ?? '').length)
        const g = range.getBoundingClientRect()
        textReadStats.ranges++
        if (g.width > 0 && g.height > 0) {
          push(k, toDocRect(g))
          textReadStats.perGrapheme++
        }
      }
      continue
    }
    if (r !== baseOf) {
      baseOf = r
      base = toDocRect(r)
    }
    const x = base.x + (xOf[c] ?? 0)
    pushSplit(widths[c] ?? new Float64Array(1), m, ls, i, x, base, push)
  }
  return true
}

/** Push the `m` grapheme rects of a chunk starting at doc x `x`, from its
 * suffix widths (see `readChunk`). */
function pushSplit(
  suf: Float64Array,
  m: number,
  ls: number,
  i: number,
  x: number,
  line: Rect,
  push: (i: number, rect: Rect) => void
): void {
  const total = (suf[0] ?? 0) + ls * m
  let x0 = 0
  for (let k = 0; k < m; k++) {
    const x1 = total - (suf[k + 1] ?? 0) - ls * (m - k - 1)
    if (x1 - x0 > 0) {
      push(i + k, {
        x: x + x0,
        y: line.y,
        width: x1 - x0,
        height: line.height
      })
    }
    x0 = x1
  }
}

/**
 * Read cells `i`..`j-1` (a whitespace-free chunk) with one Range and split
 * the chunk rect into grapheme rects from Canvas 2D advances. Grapheme k
 * starts at `W - suffix(k)`: a kerning pair adjusts its first glyph's
 * advance, which a suffix width (starting at k) excludes and a prefix
 * width (ending at k) would miss. Letter-spacing is added once per
 * grapheme, on its right. Returns false, having pushed nothing, when the
 * chunk needs per-grapheme reads: unsafe code points, a ligature
 * candidate, a rect per line or bidi fragment, or a DOM width the canvas
 * width misses by more than SPLIT_TOLERANCE (kerning or shaping the canvas
 * doesn't reproduce, collapsed or transformed text that differs, a
 * missing web font on one side).
 */
function readChunk(
  node: Text,
  range: Range,
  split: SplitSetup,
  offs: number[],
  shown: string[],
  i: number,
  j: number,
  push: (i: number, rect: Rect) => void
): boolean {
  const end = j < offs.length ? (offs[j] ?? 0) : (node.nodeValue ?? '').length
  const joined = split.plain
    ? (node.nodeValue ?? '').slice(offs[i] ?? 0, end)
    : shown.slice(i, j).join('')
  if (
    !SPLIT_SAFE.test(joined) ||
    (!split.noLiga && LIGA_CANDIDATE.test(joined))
  ) {
    return false
  }
  range.setStart(node, offs[i] ?? 0)
  range.setEnd(node, end)
  const r = range.getBoundingClientRect()
  textReadStats.ranges++
  if (r.height <= 0 || r.height > split.maxHeight) {
    return false
  }
  const suf = suffixWidths(split, joined)
  const m = j - i
  if (suf.length !== m + 1) {
    return false
  }
  const ls = split.letterSpacing
  const total = (suf[0] ?? 0) + ls * m
  if (Math.abs(r.width - total) > SPLIT_TOLERANCE) {
    split.cache.misses++
    return false
  }
  split.cache.hits++
  const base = toDocRect(r)
  pushSplit(suf, m, ls, i, base.x, base, push)
  return true
}

export type TextTransform = 'uppercase' | 'lowercase' | 'capitalize'

/** The case part of computed `text-transform`, or null. `full-width` and
 * `full-size-kana` are ignored: they swap code points for wide / full-size
 * forms, which is not implemented. */
export function textTransformOf(
  s: Pick<CSSStyleDeclaration, 'textTransform'>
): TextTransform | null {
  const v = s.textTransform ?? ''
  if (v === '' || v === 'none') {
    return null
  }
  if (v.includes('uppercase')) {
    return 'uppercase'
  }
  if (v.includes('lowercase')) {
    return 'lowercase'
  }
  return v.includes('capitalize') ? 'capitalize' : null
}

/** Content language of `el`: the closest `lang` attribute, if it is a
 * valid tag for the case-mapping functions. */
export function langOf(el: Element | null): string | undefined {
  const lang = el?.closest('[lang]')?.getAttribute('lang') ?? ''
  if (!lang) {
    return undefined
  }
  try {
    'i'.toLocaleUpperCase(lang)
    return lang
  } catch {
    return undefined
  }
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u
const MID_WORD = /^['\u2019.]$/u

/**
 * Case-map one grapheme under `tt`. `before` / `before2` are the one and
 * two graphemes before it in the same text node ('' past its start).
 * `capitalize` approximates the browser's word start (CSS Text 3 §2.1): a
 * letter or number starts a word when the grapheme before it is not a
 * letter, number or mark, except that an apostrophe or period between word
 * characters is word-internal (don't, e.g.). Context does not cross text
 * nodes, and upper case stands in for title case (ǆ, ß). Case mapping is
 * per grapheme, so context-sensitive mappings (Greek final sigma under
 * `lowercase`) are not applied.
 */
export function transformCell(
  cell: string,
  before: string,
  before2: string,
  tt: TextTransform,
  lang: string | undefined
): string {
  if (tt === 'uppercase') {
    return cell.toLocaleUpperCase(lang)
  }
  if (tt === 'lowercase') {
    return cell.toLocaleLowerCase(lang)
  }
  if (!WORD_CHAR.test(cell) || WORD_CHAR.test(before)) {
    return cell
  }
  if (MID_WORD.test(before) && WORD_CHAR.test(before2)) {
    return cell
  }
  return cell.toLocaleUpperCase(lang)
}

/** Whole-string `text-transform` (text that is not ranged per grapheme,
 * e.g. pseudo-element content). */
export function transformText(
  text: string,
  tt: TextTransform | null,
  lang: string | undefined
): string {
  if (!tt) {
    return text
  }
  let out = ''
  let b1 = ''
  let b2 = ''
  for (const g of graphemes(text)) {
    out += transformCell(g, b1, b2, tt, lang)
    b2 = b1
    b1 = g
  }
  return out
}

/** `opsz` the browser instances a variable font at: the font-size under
 * `font-optical-sizing: auto` (the initial value), none under `none`. */
export function opticalSize(
  s: CSSStyleDeclaration,
  fontSize: number
): number | null {
  const v = (s as unknown as { fontOpticalSizing?: string }).fontOpticalSizing
  return v === 'none' ? null : fontSize
}

const NO_SHADOWS: TextShadow[] = []
const shadowCache = new Map<string, TextShadow[]>()

/**
 * Computed `text-shadow` (`none`, or a comma list of `<color>? ox oy blur?`)
 * -> layers in CSS list order. A missing colour takes `currentColor`.
 * Cached per (value, colour); the result is shared, so treat it as read-only.
 */
export function readTextShadows(value: string, color: string): TextShadow[] {
  if (!value || value === 'none') {
    return NO_SHADOWS
  }
  const key = `${value}|${color}`
  const hit = shadowCache.get(key)
  if (hit) {
    return hit
  }
  const out: TextShadow[] = []
  for (const layer of splitTopLevel(value, ',')) {
    if (!layer) {
      continue
    }
    const lens: number[] = []
    let col = ''
    for (const tok of splitTopLevel(layer, ' ')) {
      if (!tok) {
        continue
      }
      if (/^-?(\d+\.?\d*|\.\d+)(e-?\d+)?(px)?$/i.test(tok)) {
        lens.push(Number.parseFloat(tok))
      } else {
        col = tok
      }
    }
    if (lens.length < 2) {
      continue
    }
    const c = parseColor(col || color)
    if (c.a <= 0.001) {
      continue
    }
    out.push({
      color: c,
      ox: lens[0] ?? 0,
      oy: lens[1] ?? 0,
      blur: Math.max(0, lens[2] ?? 0)
    })
  }
  if (shadowCache.size >= 256) {
    shadowCache.clear()
  }
  shadowCache.set(key, out)
  return out
}

/** Whether the browser applies the font's common ligatures (liga/clig).
 * Chrome turns them off under a non-zero `letter-spacing`. */
export function ligaturesEnabled(
  s: Pick<
    CSSStyleDeclaration,
    'fontVariantLigatures' | 'fontFeatureSettings' | 'letterSpacing'
  >
): boolean {
  if ((Number.parseFloat(s.letterSpacing ?? '') || 0) !== 0) {
    return false
  }
  const v = s.fontVariantLigatures ?? ''
  if (v === 'none' || v.includes('no-common-ligatures')) {
    return false
  }
  return !/["']liga["']\s+(0|off)\b/.test(s.fontFeatureSettings ?? '')
}

export interface FontMetrics {
  /** fontBoundingBoxAscent + fontBoundingBoxDescent. */
  height: number
  ascent: number
  descent: number
}

/** The computed-style fields that select a font (a style, or a synthetic
 * one built from a GlyphRun). */
export type FontStyleLike = Pick<
  CSSStyleDeclaration,
  'fontSize' | 'fontStyle' | 'fontWeight' | 'fontFamily'
>

const fontMetricsCache = new Map<string, FontMetrics>()
const glyphInkCache = new Map<string, GlyphInk | null>()
const INK_CACHE_MAX = 4096
let measureCtx: CanvasRenderingContext2D | null | undefined

function ensureMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx === undefined) {
    measureCtx = document.createElement('canvas').getContext('2d')
    // A web font finishing its load changes the metrics for the same key.
    document.fonts?.addEventListener('loadingdone', () => {
      fontMetricsCache.clear()
      glyphInkCache.clear()
      splitCache.clear()
    })
  }
  return measureCtx
}

/**
 * A style's primary font metrics (ascent/descent/height), independent of
 * `line-height`. Measured with Canvas 2D (no layout read), cached per font;
 * falls back to a 0.8/0.2 fontSize split when Canvas 2D is unavailable.
 */
export function fontMetrics(s: FontStyleLike): FontMetrics {
  const fontSize = Number.parseFloat(s.fontSize) || 16
  const font = `${s.fontStyle} ${s.fontWeight} ${fontSize}px ${s.fontFamily}`
  return metricsFor(font, fontSize)
}

/** `fontMetrics` for a canvas font string at `fontSize` px. */
function metricsFor(font: string, fontSize: number): FontMetrics {
  const hit = fontMetricsCache.get(font)
  if (hit !== undefined) {
    return hit
  }
  const measureCtx = ensureMeasureCtx()
  let ascent = fontSize * 0.8
  let descent = fontSize * 0.2
  if (measureCtx) {
    measureCtx.font = font
    const m = measureCtx.measureText('x')
    if (
      Number.isFinite(m.fontBoundingBoxAscent) &&
      Number.isFinite(m.fontBoundingBoxDescent) &&
      m.fontBoundingBoxAscent + m.fontBoundingBoxDescent > 0
    ) {
      ascent = m.fontBoundingBoxAscent
      descent = m.fontBoundingBoxDescent
    }
  }
  const out: FontMetrics = { height: ascent + descent, ascent, descent }
  if (fontMetricsCache.size >= INK_CACHE_MAX) {
    fontMetricsCache.clear()
  }
  fontMetricsCache.set(font, out)
  return out
}

/**
 * Height of an untransformed grapheme's Range rect for this style: the
 * primary font's content area, which is independent of `line-height`. Only
 * used where a transform makes the AABB solve ill-conditioned.
 */
export function contentHeight(s: CSSStyleDeclaration): number {
  return fontMetrics(s).height
}

/** Per-grapheme Canvas 2D ink extent, at the glyph's own font size (see
 * `measureGlyphInk`). */
export interface GlyphInk {
  /** Canvas 2D `measureText` advance width, px. */
  advance: number
  /** `actualBoundingBoxLeft`, px (positive = ink extends left of origin). */
  left: number
  /** `actualBoundingBoxRight`, px. */
  right: number
  /** `actualBoundingBoxDescent`, px (positive = ink extends below baseline). */
  descent: number
  /**
   * Horizontal extent (local px, relative to the glyph's origin) of ink
   * strictly AT OR BELOW the baseline — a lowercase 'p' or 'g''s full glyph
   * bbox spans almost its whole advance (the bowl sits above the
   * baseline), but `text-decoration-skip-ink` only needs to clear the
   * narrow descender stroke, so `decorations.ts` cuts around this instead
   * of `left`/`right` when it's available. Undefined when `descent` is
   * negligible (nothing to isolate).
   */
  descLeft?: number
  descRight?: number
}

let scratch: HTMLCanvasElement | OffscreenCanvas | null = null
let scratchCtx: CanvasRenderingContext2D | null = null

/** A small offscreen canvas reused for pixel-scanning descender ink,
 * grown (never shrunk) to fit `w`×`h`. */
function ensureScratch(w: number, h: number): CanvasRenderingContext2D | null {
  if (!scratch) {
    scratch =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), {
            width: w,
            height: h
          })
    scratchCtx = scratch.getContext('2d') as CanvasRenderingContext2D | null
  } else if (scratch.width < w || scratch.height < h) {
    scratch.width = Math.max(scratch.width, w)
    scratch.height = Math.max(scratch.height, h)
  }
  return scratchCtx
}

/**
 * The horizontal span (local px, relative to the text origin) of opaque
 * pixels in the rows from the baseline down to the bottom of `descentPx`,
 * for `text` rendered at `font` — i.e. just the descender stroke, not the
 * whole glyph. Returns null if nothing renders there (shouldn't happen
 * when the caller already found `actualBoundingBoxDescent > 0`).
 */
function scanDescenderExtent(
  font: string,
  text: string,
  ascentPx: number,
  descentPx: number,
  leftBearingPx: number,
  widthPx: number
): { left: number; right: number } | null {
  const pad = 2
  const originX = leftBearingPx + pad
  const baselineY = ascentPx + pad
  const w = Math.ceil(originX + widthPx + pad)
  const h = Math.ceil(baselineY + descentPx + pad)
  const ctx = ensureScratch(w, h)
  if (!ctx) {
    return null
  }
  ctx.clearRect(0, 0, w, h)
  ctx.font = font
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#fff'
  ctx.fillText(text, originX, baselineY)
  const rowStart = Math.max(0, Math.floor(baselineY))
  const rowEnd = Math.min(h, Math.ceil(baselineY + descentPx))
  if (rowEnd <= rowStart) {
    return null
  }
  const img = ctx.getImageData(0, rowStart, w, rowEnd - rowStart)
  let minX = w
  let maxX = -1
  const data = img.data
  for (let y = 0; y < img.height; y++) {
    const rowOff = y * w * 4
    for (let x = 0; x < w; x++) {
      if ((data[rowOff + x * 4 + 3] ?? 0) > 10) {
        if (x < minX) {
          minX = x
        }
        if (x > maxX) {
          maxX = x
        }
      }
    }
  }
  if (maxX < minX) {
    return null
  }
  return { left: minX - originX, right: maxX + 1 - originX }
}

/**
 * A single grapheme's ink box for `text-decoration-skip-ink`, measured with
 * Canvas 2D at the run's own font (family/weight/style) and the glyph's own
 * font size — same construction as `fontMetrics`, cached per font+grapheme.
 * Returns null when Canvas 2D is unavailable.
 */
export function measureGlyphInk(
  text: string,
  fontFamily: string,
  fontWeight: number,
  italic: boolean,
  fontSize: number
): GlyphInk | null {
  const font = `${italic ? 'italic' : 'normal'} ${fontWeight} ${fontSize}px ${fontFamily}`
  const key = `${font}\u0000${text}`
  const hit = glyphInkCache.get(key)
  if (hit !== undefined) {
    return hit
  }
  const ctx = ensureMeasureCtx()
  let out: GlyphInk | null = null
  if (ctx) {
    ctx.font = font
    ctx.textBaseline = 'alphabetic'
    const m = ctx.measureText(text)
    out = {
      advance: m.width,
      left: m.actualBoundingBoxLeft,
      right: m.actualBoundingBoxRight,
      descent: m.actualBoundingBoxDescent
    }
    if (out.descent > 0.5) {
      const sub = scanDescenderExtent(
        font,
        text,
        Math.ceil(m.actualBoundingBoxAscent || 0),
        Math.ceil(out.descent),
        Math.ceil(Math.max(0, out.left)),
        Math.ceil(Math.max(m.width, out.right, 0))
      )
      if (sub) {
        out.descLeft = sub.left
        out.descRight = sub.right
      }
    }
  }
  if (glyphInkCache.size >= INK_CACHE_MAX) {
    glyphInkCache.clear()
  }
  glyphInkCache.set(key, out)
  return out
}
