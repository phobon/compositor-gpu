import tgpu from 'typegpu'
import * as d from 'typegpu/data'
import type { Externals } from '../gpu/frame'
import { floatOffsets, floatsOf, passExternals } from '../gpu/schema'

// The text passes' instance layouts (docs/TYPEGPU.md): Slug's glyphs,
// bands and curves (GlyphTable), and the fallback-glyph atlas quads.

/** One Slug glyph instance. gref is u32 in the same bytes as the floats
 * around it (the packing writes it through a Uint32Array view). */
export const GlyphData = d
  .struct({
    /** Ink box x, y, w, h in the glyph's local line-box frame. */
    rect: d.vec4f,
    /** xy displacement, space (1 = viewport), clip shape index
     * (frame_clip_cov; 0 none). */
    offset: d.vec4f,
    color: d.vec4f,
    /** bandStart, bandCount, index in material target, _. */
    gref: d.vec4u,
    /** minX, minY, maxX, maxY (the record's space). */
    clip: d.vec4f,
    /** a, b, c, d: linear part of local -> doc. */
    xf0: d.vec4f,
    /** tx, ty (doc space), _, _. */
    xf1: d.vec4f
  })
  .$name('Glyph')

/** yMin, yMax, curveStart, curveEnd. */
export const BandData = d.struct({ bounds: d.vec4f }).$name('Band')

/** A quadratic: p = x0, y0, x1, y1; c = cx, cy, _, _. */
export const CurveData = d.struct({ p: d.vec4f, c: d.vec4f }).$name('Curve')

/** Bind group 1 of the Slug pass. */
export const slugLayout = tgpu
  .bindGroupLayout({
    glyphs: {
      storage: d.arrayOf(GlyphData),
      access: 'readonly',
      visibility: ['vertex', 'fragment']
    },
    bands: {
      storage: d.arrayOf(BandData),
      access: 'readonly',
      visibility: ['vertex', 'fragment']
    },
    curves: {
      storage: d.arrayOf(CurveData),
      access: 'readonly',
      visibility: ['vertex', 'fragment']
    }
  })
  .$idx(1)

/** What the Slug shader names beyond the Frame items. */
export const SLUG_EXTERNALS: Externals = passExternals(slugLayout, {
  Glyph: GlyphData,
  Band: BandData,
  Curve: CurveData
})

/** The Glyph, Band and Curve structs as WGSL, for fx Layers that draw
 * mirrored glyphs (their bindings are their own). */
export const SLUG_STRUCTS_WGSL: string = tgpu.resolve([
  GlyphData,
  BandData,
  CurveData
])

/** Floats per glyph: the Glyph struct. */
export const GLYPH_FLOATS = floatsOf(GlyphData)
/** Float offset of each Glyph field within a glyph. */
export const GLYPH_AT = floatOffsets(GlyphData)
/** Floats per curve. */
export const CURVE_FLOATS = floatsOf(CurveData)
/** Float offset of each Curve field within a curve. */
export const CURVE_AT = floatOffsets(CurveData)

/** A fallback glyph drawn from the Canvas 2D glyph atlas. */
export const QuadData = d
  .struct({
    /** x, y, w, h in the glyph's local line-box frame. */
    rect: d.vec4f,
    /** u0, v0, u1, v1. */
    uv: d.vec4f,
    /** sRGB straight alpha; a = glyph alpha * run opacity. */
    color: d.vec4f,
    /** Tint (1 = mono coverage), space (1 = viewport), clip shape index
     * (frame_clip_cov; 0 none), _. */
    params: d.vec4f,
    /** minX, minY, maxX, maxY (the record's space). */
    clip: d.vec4f,
    /** a, b, c, d: linear part of local -> doc. */
    xf0: d.vec4f,
    /** tx, ty (doc space, offset applied), _, _. */
    xf1: d.vec4f
  })
  .$name('Quad')

/** Bind group 1 of the atlas pass: the quads (aligned with scene glyph
 * order), the atlas texture (rgba8unorm, premultiplied) and its sampler
 * (linear, clamped). */
export const atlasLayout = tgpu
  .bindGroupLayout({
    quads: {
      storage: d.arrayOf(QuadData),
      access: 'readonly',
      visibility: ['vertex', 'fragment']
    },
    tex: { texture: d.texture2d(d.f32), visibility: ['fragment'] },
    samp: { sampler: 'filtering', visibility: ['fragment'] }
  })
  .$idx(1)

/** What the atlas shader names beyond the Frame items. */
export const ATLAS_EXTERNALS: Externals = passExternals(atlasLayout, {
  Quad: QuadData
})

/** Floats per atlas quad. */
export const ATLAS_QUAD_FLOATS = floatsOf(QuadData)
/** Float offset of each Quad field within a quad. */
export const QUAD_AT = floatOffsets(QuadData)
