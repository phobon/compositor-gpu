import * as opentype from 'opentype.js'

/** A quadratic Bézier segment in em space (unitsPerEm normalised to 0..1). */
export interface Quad {
  x0: number
  y0: number
  cx: number
  cy: number
  x1: number
  y1: number
}

export interface GlyphBands {
  advance: number
  /** Tight glyph bounding box in em units (÷ unitsPerEm), y-up. */
  bbox: { x1: number; y1: number; x2: number; y2: number }
  /** Band boundaries (y, ascending) with slice [start,end) into `curves`. */
  bands: { yMin: number; yMax: number; start: number; end: number }[]
  /** Flat quad list, grouped by band (a quad may appear in multiple bands). */
  curves: Quad[]
}

export interface ParsedFont {
  fontId: number
  unitsPerEm: number
  /** Font ascent/descent in em units (÷ unitsPerEm); descender is negative. */
  ascender: number
  descender: number
  glyphForCodePoint(cp: number): number
  glyph(index: number): GlyphBands
}

const BAND_COUNT = 16

/**
 * Parse a font (ArrayBuffer) and expose per-glyph banded quadratic outlines,
 * the layout the Slug fragment shader consumes.
 *
 * STATUS: outline extraction + cubic->quadratic reduction + band bucketing are
 * implemented. Packing into GPU buffers and cmap coverage beyond the BMP are
 * the remaining work (see shaders.ts / README).
 */
/** Variation axis coordinates in user units, e.g. `{ wght: 700 }`. */
export type AxisCoords = Record<string, number>

/** A parsed font file. Reuse one handle to derive many instances cheaply. */
export interface FontHandle {
  font: opentype.Font
  upm: number
  ascender: number
  descender: number
  /** Weight-axis range, present only for variable fonts with a `wght` axis. */
  wght?: { min: number; def: number; max: number }
}

// @types/opentype.js predates variable-font support, so reach the runtime API
// (font.variation, font.tables.fvar) through narrow casts.
interface VariationApi {
  getTransform(glyph: opentype.Glyph, coords: AxisCoords): opentype.Glyph
}
interface FvarAxis {
  tag: string
  minValue: number
  defaultValue: number
  maxValue: number
}
const variationOf = (font: opentype.Font): VariationApi =>
  (font as unknown as { variation: VariationApi }).variation
const fvarAxes = (font: opentype.Font): FvarAxis[] =>
  (font.tables as unknown as { fvar?: { axes: FvarAxis[] } }).fvar?.axes ?? []

/** Parse a font file once. Cheap to keep; instances share its tables. */
export function loadFontFile(buffer: ArrayBuffer): FontHandle {
  const font = opentype.parse(buffer)
  const upm = font.unitsPerEm || 1000
  const axis = fvarAxes(font).find((a) => a.tag === 'wght')
  return {
    font,
    upm,
    ascender: (font.ascender ?? upm * 0.8) / upm,
    descender: (font.descender ?? -upm * 0.2) / upm,
    wght: axis
      ? { min: axis.minValue, def: axis.defaultValue, max: axis.maxValue }
      : undefined
  }
}

/**
 * Derive a ParsedFont from a handle. With `coords` on a variable font, glyph
 * outlines are interpolated to those axis coordinates (gvar), so one file backs
 * many weights instead of shipping a static face per weight.
 */
export function makeInstance(
  handle: FontHandle,
  fontId: number,
  coords?: AxisCoords
): ParsedFont {
  const { font, upm } = handle
  const cache = new Map<number, GlyphBands>()
  const vary = coords !== undefined && handle.wght !== undefined

  const glyphForCodePoint = (cp: number): number => {
    const g = font.charToGlyph(String.fromCodePoint(cp))
    return g?.index ?? 0
  }

  const glyph = (index: number): GlyphBands => {
    const cached = cache.get(index)
    if (cached) return cached
    const raw = font.glyphs.get(index)
    const g = vary ? variationOf(font).getTransform(raw, coords) : raw
    const bb = g.getBoundingBox()
    const quads = outlineToQuads(g, bb)
    const bands = bucketIntoBands(quads)
    const result: GlyphBands = {
      advance: (g.advanceWidth ?? 0) / upm,
      bbox: {
        x1: bb.x1 / upm,
        y1: bb.y1 / upm,
        x2: bb.x2 / upm,
        y2: bb.y2 / upm
      },
      bands: bands.bands,
      curves: bands.curves
    }
    cache.set(index, result)
    return result
  }

  return {
    fontId,
    unitsPerEm: upm,
    ascender: handle.ascender,
    descender: handle.descender,
    glyphForCodePoint,
    glyph
  }
}

/** Parse a static font into a single ParsedFont (the default, non-varied). */
export function parseFont(buffer: ArrayBuffer, fontId: number): ParsedFont {
  return makeInstance(loadFontFile(buffer), fontId)
}

/**
 * Flatten a glyph's outline to quadratics normalised into its own tight
 * bounding box [0,1]^2, y-up — matching the shader's `em` space. Reads
 * `glyph.path` (font units, y-up), NOT getPath() (which flips to y-down and
 * is baseline-relative, so its outline falls outside [0,1] and never fills).
 */
function outlineToQuads(
  glyph: opentype.Glyph,
  bb: { x1: number; y1: number; x2: number; y2: number }
): Quad[] {
  const w = bb.x2 - bb.x1 || 1
  const h = bb.y2 - bb.y1 || 1
  const nx = (v: number) => (v - bb.x1) / w
  const ny = (v: number) => (v - bb.y1) / h
  const norm = (q: Quad): Quad => ({
    x0: nx(q.x0),
    y0: ny(q.y0),
    cx: nx(q.cx),
    cy: ny(q.cy),
    x1: nx(q.x1),
    y1: ny(q.y1)
  })

  const quads: Quad[] = []
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0

  for (const c of glyph.path.commands) {
    if (c.type === 'M') {
      x = c.x
      y = c.y
      sx = x
      sy = y
    } else if (c.type === 'L') {
      quads.push(
        norm({
          x0: x,
          y0: y,
          cx: (x + c.x) / 2,
          cy: (y + c.y) / 2,
          x1: c.x,
          y1: c.y
        })
      )
      x = c.x
      y = c.y
    } else if (c.type === 'Q') {
      quads.push(norm({ x0: x, y0: y, cx: c.x1, cy: c.y1, x1: c.x, y1: c.y }))
      x = c.x
      y = c.y
    } else if (c.type === 'C') {
      for (const q of cubicToQuads(x, y, c.x1, c.y1, c.x2, c.y2, c.x, c.y)) {
        quads.push(norm(q))
      }
      x = c.x
      y = c.y
    } else if (c.type === 'Z') {
      if (x !== sx || y !== sy) {
        quads.push(
          norm({
            x0: x,
            y0: y,
            cx: (x + sx) / 2,
            cy: (y + sy) / 2,
            x1: sx,
            y1: sy
          })
        )
      }
      x = sx
      y = sy
    }
  }
  return quads
}

function cubicToQuads(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number
): [Quad, Quad] {
  // split cubic at t=0.5, approximate each half with a quadratic
  const mid = (a: number, b: number) => (a + b) / 2
  const ax = mid(x0, x1)
  const ay = mid(y0, y1)
  const bx = mid(x1, x2)
  const by = mid(y1, y2)
  const cxp = mid(x2, x3)
  const cyp = mid(y2, y3)
  const dx = mid(ax, bx)
  const dy = mid(ay, by)
  const ex = mid(bx, cxp)
  const ey = mid(by, cyp)
  const mx = mid(dx, ex)
  const my = mid(dy, ey)
  return [
    { x0, y0, cx: ax, cy: ay, x1: mx, y1: my },
    { x0: mx, y0: my, cx: ex, cy: ey, x1: x3, y1: y3 }
  ]
}

/** Bucket quads into horizontal bands (Slug's acceleration structure). */
function bucketIntoBands(quads: Quad[]): {
  bands: GlyphBands['bands']
  curves: Quad[]
} {
  const curves: Quad[] = []
  const bands: GlyphBands['bands'] = []
  for (let i = 0; i < BAND_COUNT; i++) {
    const yMin = i / BAND_COUNT
    const yMax = (i + 1) / BAND_COUNT
    const start = curves.length
    for (const q of quads) {
      const lo = Math.min(q.y0, q.cy, q.y1)
      const hi = Math.max(q.y0, q.cy, q.y1)
      if (hi >= yMin && lo <= yMax) curves.push(q)
    }
    bands.push({ yMin, yMax, start, end: curves.length })
  }
  return { bands, curves }
}
