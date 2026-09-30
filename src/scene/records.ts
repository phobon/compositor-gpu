// Plain data records describing what to paint, in DOCUMENT space (CSS px from
// the top-left of the document) — except records with `space: 'viewport'`
// (a `position: fixed` subtree), whose rects, xforms and clips are in
// viewport space (CSS px from the viewport's top-left; no scroll offset).
// No GPU types leak into this file.

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
  /** background-repeat is not `no-repeat`: the padding-box tile repeats
   * into the border area when background-clip reaches it. */
  repeat?: boolean
}

/** Coordinate space of a record's rect / xform / clip (see top of file).
 * Absent means 'doc'. */
export type Space = 'doc' | 'viewport'

/** Border-style code the box shader draws: 0 solid, 1 dashed, 2 dotted,
 * 3 double. Packed per side into `params.x` as base-4 digits. */
export type BorderStyle = 0 | 1 | 2 | 3

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
  /**
   * Background painting area (background-clip) as per-side insets from the
   * border box, [top, right, bottom, left]: the border widths for
   * padding-box, plus padding for content-box. Absent = border-box, where
   * the fill runs under the border.
   */
  bgInset?: [number, number, number, number]
  /**
   * Per-side border, [top, right, bottom, left] (CSS order). A side with
   * style none/hidden has width 0. `styles` is the BorderStyle code per
   * side; groove/ridge/inset/outset draw solid. Null when no side paints.
   */
  border: {
    widths: [number, number, number, number]
    colors: [RGBA, RGBA, RGBA, RGBA]
    styles: [BorderStyle, BorderStyle, BorderStyle, BorderStyle]
  } | null
  /**
   * Outer box-shadow: when set, the box pass draws this record as a blurred
   * rounded rect of `fill` (the shadow colour) — `rect`/`local`/`radius`
   * describe the SHADOW's box (element box offset + spread) padded by
   * `shadowPad(blur)` on every side so the blur has room; `border` is
   * ignored. `blur` is the CSS blur radius in px; `inner` is the element's
   * own rounded box in the padded local frame, masked out (CSS clips outer
   * shadows to outside the border box).
   *
   * `inset`: an inset shadow. `rect`/`local`/`radius` are then the
   * element's PADDING box (unpadded) — coverage is masked to its inside —
   * and `inner` is the shadow box (padding box offset by (ox, oy), shrunk
   * by `spread`) in that frame; the shadow covers what lies outside
   * `inner`, blurred.
   */
  shadow?: {
    color: RGBA
    blur: number
    inner: { x: number; y: number; w: number; h: number; radius: Corners }
    inset?: boolean
  } | null
  /** Multiplier applied by the pass. The reader writes 1: an element's
   * opacity is applied once by its opacity group (see stacking.ts). */
  opacity: number
  /** Global paint order (integer; back-to-front across all layers). */
  z: number
  /** Doc-space clip rect from a clipping ancestor (overflow != visible). */
  clip?: Rect | null
  /**
   * Footprint used by the batch builder's overlap test instead of `rect`
   * when set. Shadows set it to the box inset to ~1.5σ so their near-zero
   * blur tails don't split batches (paint order in the tail is invisible).
   */
  batchRect?: Rect
  /** 'viewport' inside a `position: fixed` subtree; absent = 'doc'. */
  space?: Space
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
  /**
   * Background positioning area (background-origin) as per-side insets
   * [top, right, bottom, left] from the record's local box (the painted
   * area, background-clip). Negative when the origin box is the larger.
   * Absent: the positioning area is the local box.
   */
  originInset?: [number, number, number, number]
  /** Multiplier applied by the pass. The reader writes 1: an element's
   * opacity is applied once by its opacity group (see stacking.ts). */
  opacity: number
  /** Global paint order (integer; back-to-front across all layers). */
  z: number
  /** Source pixels change over time (<video>, <canvas>): re-upload each frame. */
  dynamic?: boolean
  /** Doc-space clip rect from a clipping ancestor (overflow != visible). */
  clip?: Rect | null
  /** 'viewport' inside a `position: fixed` subtree; absent = 'doc'. */
  space?: Space
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
  /** The grapheme cluster as painted, i.e. after `text-transform` (one
   * source grapheme can map to several code points: ß -> SS). Used by the
   * fallback atlas, ligature text and skip-ink measurement. */
  text: string
  /** Colour / emoji grapheme (drawn by the fallback atlas in its own
   * colours). Classified once at read time. */
  colour: boolean
  /** Code points in `text`, variation selectors excluded (> 1 = a cluster
   * Slug can't shape; drawn by the fallback atlas). */
  codePoints: number
  fontId: number
  /** Computed font-size in CSS px (for baseline/ink placement). */
  fontSize: number
  color: RGBA
  /** Per-glyph displacement applied in the vertex shader. Mutated by onGlyph. */
  offset: { x: number; y: number }
}

/** One `text-shadow` layer. */
export interface TextShadow {
  color: RGBA
  ox: number
  oy: number
  /** CSS blur radius in px (σ = blur / 2). */
  blur: number
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
  /** `opsz` axis value a variable face should be instanced at: the
   * computed font-size under `font-optical-sizing: auto` (the browser's
   * rule), null under `none`. Ignored by faces without the axis. */
  opsz: number | null
  italic: boolean
  /** False when the element disables common ligatures
   * (`font-variant-ligatures: none | no-common-ligatures`, `"liga" 0`). */
  ligatures: boolean
  color: RGBA
  glyphs: Glyph[]
  /** Multiplier applied by the pass. The reader writes 1: an element's
   * opacity is applied once by its opacity group (see stacking.ts). */
  opacity: number
  /** Global paint order (integer; back-to-front across all layers). */
  z: number
  /**
   * `underline` / `overline` boxes for this run, one BoxRecord per line
   * fragment, painted immediately BEFORE the run's glyphs (flatten emits
   * them first). Filled by the reader.
   */
  decorations?: BoxRecord[]
  /** `line-through` boxes, painted immediately AFTER the run's glyphs
   * (CSS paints line-through over the text). */
  decorationsOver?: BoxRecord[]
  /**
   * `text-shadow` layers in CSS list order (the first is painted top-most;
   * all paint below the glyphs). Offsets and blur are CSS px in the glyph's
   * local frame. Absent / empty for `none`.
   */
  textShadows?: TextShadow[]
  /** Doc-space clip rect from a clipping ancestor (overflow != visible). */
  clip?: Rect | null
  /** Space of every glyph's rect / xform and of `clip`; absent = 'doc'. */
  space?: Space
}

export type SceneRecord = BoxRecord | ImageRecord | GlyphRun
