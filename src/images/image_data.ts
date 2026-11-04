import tgpu from 'typegpu'
import * as d from 'typegpu/data'
import type { Externals } from '../gpu/frame'
import { floatOffsets, floatsOf, passExternals } from '../gpu/schema'
import { sdBox } from '../gpu/sdf'

// The image pass's instance layout (docs/TYPEGPU.md). Local space: the
// record's untransformed box, origin at its top-left.

/** One image record, as the image shader reads it. */
export const ImgData = d
  .struct({
    /** x, y, w, h, local space (the quad). */
    rect: d.vec4f,
    /** u0, v0, u1, v1: used unless FLAG_UV_FROM_TILE is set. */
    uv: d.vec4f,
    /** Opacity, flags, atlas half-texel inset u, v. */
    params: d.vec4f,
    /** minX, minY, maxX, maxY (the record's space). */
    clip: d.vec4f,
    /** tl, tr, br, bl (px): clips against the local box. */
    radius: d.vec4f,
    /** originX, originY, w, h (local space): fit 'none' only. */
    tile: d.vec4f,
    /** a, b, c, d: linear part of local -> doc. */
    xf0: d.vec4f,
    /** tx, ty (doc space), local box w, h. */
    xf1: d.vec4f,
    /** u0, v0, u1, v1 of the entry in atlas uv space (FLAG_ATLAS). */
    atlas: d.vec4f,
    /** Vertical radii (= radius: circular). */
    ry: d.vec4f
  })
  .$name('Img')

/** Bind group 1 of the image pass. */
export const imageLayout = tgpu
  .bindGroupLayout({
    imgs: {
      storage: d.arrayOf(ImgData),
      access: 'readonly',
      visibility: ['vertex', 'fragment']
    },
    tex: { texture: d.texture2d(d.f32), visibility: ['fragment'] },
    samp: { sampler: 'filtering', visibility: ['fragment'] }
  })
  .$idx(1)

/** What the image shader names beyond the Frame items. */
export const IMAGE_EXTERNALS: Externals = passExternals(imageLayout, {
  Img: ImgData,
  sd_box: sdBox
})

/** Floats an image takes in the instance buffer. */
export const FLOATS_PER_IMAGE = floatsOf(ImgData)

/** Float offset of each Img field within an image. */
export const IMG_AT = floatOffsets(ImgData)
