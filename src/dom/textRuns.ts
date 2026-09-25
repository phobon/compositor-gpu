import type { Glyph, GlyphRun, TextShadow } from '../scene/records'
import { isColorGrapheme } from '../text/glyphAtlas'
import { parseColor } from '../util/color'
import { splitTopLevel } from '../util/css'
import { toDocRect } from './styles'

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
  if (hit) return hit
  const out = segmenter
    ? Array.from(segmenter.segment(text), (s) => s.segment)
    : Array.from(text)
  if (graphemeCache.size >= CACHE_MAX) graphemeCache.clear()
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
  if (hit) return hit
  let codePoints = 0
  for (const ch of cell) {
    if (!isVariationSelector(ch.codePointAt(0) ?? 0)) codePoints++
  }
  const out = { colour: isColorGrapheme(cell), codePoints }
  if (classCache.size >= CACHE_MAX) classCache.clear()
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
 * NOTE: getClientRects here is a forced layout read. The caller MUST batch all
 * of these before any GPU write in a frame (see observer/sync).
 *
 * `s` is the computed style of the text node's parent element.
 *
 * `glyphId` is set to the grapheme's first code point as a placeholder; the
 * Slug font stage remaps it through the font cmap to a real glyph index.
 */
export function readTextNode(
  node: Text,
  s: CSSStyleDeclaration,
  runId: number,
  fontId: number,
  startIndex: number
): GlyphRun | null {
  const text = node.nodeValue
  if (!text || !text.trim()) return null
  // Hidden text paints nothing (and so no decorations); a descendant
  // element can still set `visibility: visible` for its own text.
  if (s.visibility !== 'visible') return null
  const color = parseColor(s.color)
  const fontSize = Number.parseFloat(s.fontSize) || 16
  const fontFamily = (s.fontFamily.split(',')[0] ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
  const fontWeight = Number.parseInt(s.fontWeight, 10) || 400
  const italic = s.fontStyle === 'italic' || s.fontStyle.startsWith('oblique')
  const glyphs: Glyph[] = []

  const range = document.createRange()
  const cells = graphemes(text)
  let offset = 0
  let index = startIndex
  for (const cell of cells) {
    const len = cell.length
    if (cell.trim().length === 0) {
      offset += len
      index += 1
      continue
    }
    range.setStart(node, offset)
    range.setEnd(node, offset + len)
    const r = range.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) {
      const rect = toDocRect(r)
      const cls = graphemeClass(cell)
      glyphs.push({
        index,
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
    offset += len
    index += 1
  }
  range.detach?.()
  if (glyphs.length === 0) return null
  return {
    kind: 'text',
    id: runId,
    fontId,
    fontFamily,
    fontStack: s.fontFamily,
    fontWeight,
    italic,
    ligatures: ligaturesEnabled(s),
    color,
    glyphs,
    textShadows: readTextShadows(s.textShadow, s.color),
    opacity: 1,
    z: 0
  }
}

const NO_SHADOWS: TextShadow[] = []
const shadowCache = new Map<string, TextShadow[]>()

/**
 * Computed `text-shadow` (`none`, or a comma list of `<color>? ox oy blur?`)
 * -> layers in CSS list order. A missing colour takes `currentColor`.
 * Cached per (value, colour); the result is shared, so treat it as read-only.
 */
export function readTextShadows(value: string, color: string): TextShadow[] {
  if (!value || value === 'none') return NO_SHADOWS
  const key = `${value}|${color}`
  const hit = shadowCache.get(key)
  if (hit) return hit
  const out: TextShadow[] = []
  for (const layer of splitTopLevel(value, ',')) {
    if (!layer) continue
    const lens: number[] = []
    let col = ''
    for (const tok of splitTopLevel(layer, ' ')) {
      if (!tok) continue
      if (/^-?(\d+\.?\d*|\.\d+)(e-?\d+)?(px)?$/i.test(tok)) {
        lens.push(Number.parseFloat(tok))
      } else {
        col = tok
      }
    }
    if (lens.length < 2) continue
    const c = parseColor(col || color)
    if (c.a <= 0.001) continue
    out.push({
      color: c,
      ox: lens[0] ?? 0,
      oy: lens[1] ?? 0,
      blur: Math.max(0, lens[2] ?? 0)
    })
  }
  if (shadowCache.size >= 256) shadowCache.clear()
  shadowCache.set(key, out)
  return out
}

/** Whether the browser applies the font's common ligatures (liga/clig). */
export function ligaturesEnabled(
  s: Pick<CSSStyleDeclaration, 'fontVariantLigatures' | 'fontFeatureSettings'>
): boolean {
  const v = s.fontVariantLigatures ?? ''
  if (v === 'none' || v.includes('no-common-ligatures')) return false
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
  const hit = fontMetricsCache.get(font)
  if (hit !== undefined) return hit
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
  if (fontMetricsCache.size >= INK_CACHE_MAX) fontMetricsCache.clear()
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
  if (!ctx) return null
  ctx.clearRect(0, 0, w, h)
  ctx.font = font
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#fff'
  ctx.fillText(text, originX, baselineY)
  const rowStart = Math.max(0, Math.floor(baselineY))
  const rowEnd = Math.min(h, Math.ceil(baselineY + descentPx))
  if (rowEnd <= rowStart) return null
  const img = ctx.getImageData(0, rowStart, w, rowEnd - rowStart)
  let minX = w
  let maxX = -1
  const data = img.data
  for (let y = 0; y < img.height; y++) {
    const rowOff = y * w * 4
    for (let x = 0; x < w; x++) {
      if ((data[rowOff + x * 4 + 3] ?? 0) > 10) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
      }
    }
  }
  if (maxX < minX) return null
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
  if (hit !== undefined) return hit
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
  if (glyphInkCache.size >= INK_CACHE_MAX) glyphInkCache.clear()
  glyphInkCache.set(key, out)
  return out
}
