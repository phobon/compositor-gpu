// Plain data records describing what to paint, in DOCUMENT space (CSS px from
// the top-left of the document). No GPU types leak into this file.

import type { Affine } from '../dom/transform'

export type { Affine }

/** Untransformed (layout) size of a record's box, in CSS px. */
export interface LocalSize {
  w: number
  h: number
}

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

export interface GradientStop {
  /** Linear RGBA (parseColor output). */
  color: RGBA
  /** Position along the gradient line / radius, 0..1 (after CSS fix-up). */
  pos: number
}

/** A resolved CSS gradient (angles/corners already resolved against rect). */
export interface Gradient {
  kind: 'linear' | 'radial'
  /** linear: CSS angle in radians (0 = to top, clockwise). */
  angle: number
  /** radial: centre as a fraction of the box (0..1). */
  center: [number, number]
  /** radial: radii in px. */
  radii: [number, number]
  stops: GradientStop[]
}

export interface BoxRecord {
  kind: 'box'
  id: number
  /** Doc-space AABB (the transformed box's bounds when transformed). */
  rect: Rect
  /** Maps local box coords (origin top-left, size `local`) to doc space.
   * Untransformed: [1, 0, 0, 1, rect.x, rect.y]. */
  xform: Affine
  /** Untransformed size; equals the rect size when untransformed. */
  local: LocalSize
  radius: Corners
  fill: RGBA
  /** First background-image layer when it is a gradient; drawn over fill. */
  gradient?: Gradient | null
  border: { width: number; color: RGBA } | null
  /** Effective opacity: own opacity × every ancestor's (see stacking.ts). */
  opacity: number
  /** Global paint order (integer; back-to-front across all layers). */
  z: number
  /** Doc-space clip rect from a clipping ancestor (overflow != visible). */
  clip?: Rect | null
}

export interface ImageRecord {
  kind: 'image'
  id: number
  /** Doc-space AABB (the transformed box's bounds when transformed). */
  rect: Rect
  /** Maps local box coords (origin top-left, size `local`) to doc space.
   * Untransformed: [1, 0, 0, 1, rect.x, rect.y]. */
  xform: Affine
  /** Untransformed size; equals the rect size when untransformed. */
  local: LocalSize
  source: CanvasImageSource
  /** 'none' = natural size (background-size: auto), placed by `position`. */
  objectFit: 'fill' | 'contain' | 'cover' | 'none'
  /** object-position / background-position as fractions of the free space
   * (CSS percentage semantics). <img> defaults to [0.5, 0.5], backgrounds
   * to [0, 0]. */
  position: [number, number]
  /** Tile the image (background-repeat: repeat) — only with fit 'none'. */
  repeat: boolean
  /** Border radii of the owning element, used to clip the quad. */
  radius: Corners
  /** Effective opacity (own × ancestors). */
  opacity: number
  /** Global paint order (integer; back-to-front across all layers). */
  z: number
  /** Source pixels change over time (<video>, <canvas>): re-upload each frame. */
  dynamic?: boolean
  /** Doc-space clip rect from a clipping ancestor (overflow != visible). */
  clip?: Rect | null
}

/** One shaped glyph, positioned by the browser, in document space. */
export interface Glyph {
  /** Stable index within the run — handy for staggered effects. */
  index: number
  /** Doc-space AABB of the grapheme's line box. */
  rect: Rect
  /** Maps local line-box coords (origin top-left, size `local`) to doc space.
   * Untransformed: [1, 0, 0, 1, rect.x, rect.y]. */
  xform: Affine
  /** Untransformed size; equals the rect size when untransformed. */
  local: LocalSize
  /** Index into the font's glyph table (resolved by the text backend). */
  glyphId: number
  /** The grapheme cluster itself (for the Canvas 2D fallback atlas). */
  text: string
  fontId: number
  /** Computed font-size in CSS px (for baseline/ink placement). */
  fontSize: number
  color: RGBA
  /** Per-glyph displacement applied in the vertex shader. Mutated by onGlyph. */
  offset: { x: number; y: number }
}

export interface GlyphRun {
  kind: 'text'
  id: number
  fontId: number
  /** First CSS font-family of the run's element. */
  fontFamily: string
  /** The full computed font-family list, as CSS (for the fallback atlas). */
  fontStack: string
  /** Numeric font-weight (normal=400, bold=700). */
  fontWeight: number
  italic: boolean
  color: RGBA
  glyphs: Glyph[]
  /** Effective opacity of the run's element (own × ancestors). */
  opacity: number
  /** Global paint order (integer; back-to-front across all layers). */
  z: number
  /** Doc-space clip rect from a clipping ancestor (overflow != visible). */
  clip?: Rect | null
}

export type SceneRecord = BoxRecord | ImageRecord | GlyphRun
