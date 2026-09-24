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
  /** Band boundaries (y, ascending) with slice [start,end) into `curves`. */
  bands: { yMin: number; yMax: number; start: number; end: number }[]
  /** Flat quad list, grouped by band (a quad may appear in multiple bands). */
  curves: Quad[]
}

export interface ParsedFont {
  fontId: number
  unitsPerEm: number
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
export function parseFont(buffer: ArrayBuffer, fontId: number): ParsedFont {
  const font = opentype.parse(buffer)
  const upm = font.unitsPerEm || 1000
  const cache = new Map<number, GlyphBands>()

  const glyphForCodePoint = (cp: number): number => {
    const g = font.charToGlyph(String.fromCodePoint(cp))
    return g?.index ?? 0
  }

  const glyph = (index: number): GlyphBands => {
    const cached = cache.get(index)
    if (cached) return cached
    const g = font.glyphs.get(index)
    const quads = outlineToQuads(g, upm)
    const bands = bucketIntoBands(quads)
    const result: GlyphBands = {
      advance: (g.advanceWidth ?? 0) / upm,
      bands: bands.bands,
      curves: bands.curves
    }
    cache.set(index, result)
    return result
  }

  return { fontId, unitsPerEm: upm, glyphForCodePoint, glyph }
}

/** Flatten opentype path commands to quadratics in normalised em space. */
function outlineToQuads(glyph: opentype.Glyph, upm: number): Quad[] {
  const path = glyph.getPath(0, 0, upm) // y-down; we normalise below
  const quads: Quad[] = []
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  const n = (v: number) => v / upm

  for (const c of path.commands) {
    if (c.type === 'M') {
      x = c.x
      y = c.y
      sx = x
      sy = y
    } else if (c.type === 'L') {
      quads.push(quad(x, y, (x + c.x) / 2, (y + c.y) / 2, c.x, c.y, n))
      x = c.x
      y = c.y
    } else if (c.type === 'Q') {
      quads.push(quad(x, y, c.x1, c.y1, c.x, c.y, n))
      x = c.x
      y = c.y
    } else if (c.type === 'C') {
      // reduce cubic to two quadratics via midpoint split (scaffold-grade)
      const [q1, q2] = cubicToQuads(x, y, c.x1, c.y1, c.x2, c.y2, c.x, c.y)
      quads.push(mapQuad(q1, n), mapQuad(q2, n))
      x = c.x
      y = c.y
    } else if (c.type === 'Z') {
      if (x !== sx || y !== sy) {
        quads.push(quad(x, y, (x + sx) / 2, (y + sy) / 2, sx, sy, n))
      }
      x = sx
      y = sy
    }
  }
  return quads
}

function quad(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  n: (v: number) => number
): Quad {
  return { x0: n(x0), y0: n(y0), cx: n(cx), cy: n(cy), x1: n(x1), y1: n(y1) }
}

function mapQuad(q: Quad, n: (v: number) => number): Quad {
  return {
    x0: n(q.x0),
    y0: n(q.y0),
    cx: n(q.cx),
    cy: n(q.cy),
    x1: n(q.x1),
    y1: n(q.y1)
  }
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
