// Plain data records describing what to paint, in DOCUMENT space (CSS px from
// the top-left of the document). No GPU types leak into this file.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Linear 0..1 RGBA. */
export interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

/** Corner radii in px: [topLeft, topRight, bottomRight, bottomLeft]. */
export type Corners = [number, number, number, number]

export interface BoxRecord {
  kind: 'box'
  id: number
  rect: Rect
  radius: Corners
  fill: RGBA
  border: { width: number; color: RGBA } | null
  opacity: number
  z: number
}

export interface ImageRecord {
  kind: 'image'
  id: number
  rect: Rect
  source: CanvasImageSource
  objectFit: 'fill' | 'contain' | 'cover'
  opacity: number
  z: number
}

/** One shaped glyph, positioned by the browser, in document space. */
export interface Glyph {
  /** Stable index within the run — handy for staggered effects. */
  index: number
  rect: Rect
  /** Index into the font's glyph table (resolved by the text backend). */
  glyphId: number
  fontId: number
  color: RGBA
  /** Per-glyph displacement applied in the vertex shader. Mutated by onGlyph. */
  offset: { x: number; y: number }
}

export interface GlyphRun {
  kind: 'text'
  id: number
  fontId: number
  color: RGBA
  glyphs: Glyph[]
  z: number
}

export type SceneRecord = BoxRecord | ImageRecord | GlyphRun
