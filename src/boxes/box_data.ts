import tgpu from 'typegpu'
import * as d from 'typegpu/data'

// The box pass's instance layout (docs/TYPEGPU.md): one definition for
// the WGSL struct, the buffer size and the offsets BoxPass.upload packs.

/** One box record, as the box shader reads it (bind group 1, binding 0). */
export const BoxData = d
  .struct({
    /** a, b, c, d: linear part of local -> doc. */
    xf0: d.vec4f,
    /** tx, ty (doc space), w, h (local size, CSS px). */
    xf1: d.vec4f,
    /** Radii tl, tr, br, bl. */
    radius: d.vec4f,
    /** sRGB rgba. */
    fill: d.vec4f,
    /** Top border colour, sRGB rgba. */
    bc0: d.vec4f,
    /** Border styles (base-4 t, r, b, l), opacity, clip shape index
     * (frame_clip_cov; 0 none), space. */
    params: d.vec4f,
    /** minX, minY, maxX, maxY (the record's space). */
    clip: d.vec4f,
    /** Kind (0 none, 1 linear, 2 radial, 3 conic; +8 repeating; -1
     * dashed, -2 dotted, -3 wavy decoration), angle, first stop, stop
     * count. */
    grad: d.vec4f,
    /** Radial: cx, cy (padding-box fractions), rx, ry (px). */
    gradc: d.vec4f,
    /** Shadow: sigma, pad (local px), isShadow, inset; plain box: w =
     * gradient tile repeats (1 x, 2 y). */
    sh0: d.vec4f,
    /** Shadow: inner box x, y, w, h (local px), the element box (outer)
     * or the shadow box (inset); plain box: background-clip insets t, r,
     * b, l. */
    sh1: d.vec4f,
    /** Shadow: inner radii tl, tr, br, bl; plain box: dash path arc
     * lengths tl, tr, br, bl. */
    shr: d.vec4f,
    /** Border widths top, right, bottom, left. */
    bw: d.vec4f,
    /** Right border colour. */
    bc1: d.vec4f,
    /** Bottom border colour. */
    bc2: d.vec4f,
    /** Left border colour. */
    bc3: d.vec4f,
    /** Vertical radii tl, tr, br, bl (= radius: circular). */
    ry: d.vec4f,
    /** Gradient tile x, y (from the padding box), w, h; w = 0: the
     * padding box. Shadows: inner vertical radii (with shr). Decorations:
     * thickness, start, length, wave centreline y. */
    gt: d.vec4f
  })
  .$name('Box')

/** Bind group 1 of the box pass: the boxes, and the gradient stops (two
 * vec4s a stop: sRGB straight-alpha rgba, then (pos, 0, 0, 0)). The GPU
 * layout is made by hand in BoxPass to match. */
export const boxLayout = tgpu
  .bindGroupLayout({
    boxes: {
      storage: d.arrayOf(BoxData),
      access: 'readonly',
      visibility: ['vertex', 'fragment']
    },
    stops: {
      storage: d.arrayOf(d.vec4f),
      access: 'readonly',
      visibility: ['fragment']
    }
  })
  .$idx(1)

/** The Box struct and bind group 1, as WGSL for the box shader. */
export const BOX_DECLS: string = tgpu.resolve({
  template: 'box_prelude',
  externals: {
    box_prelude: tgpu['~unstable']
      // The names in this comment pull each item into the resolution.
      .declare('// L.$.boxes L.$.stops')
      .$uses({ L: boxLayout })
  }
})

/** Floats a box takes in the instance buffer. */
export const FLOATS_PER_BOX = d.sizeOf(BoxData) / 4

type BoxField = keyof (typeof BoxData)['propTypes']

/** Float offset of each Box field within a box. */
export const BOX_AT = Object.fromEntries(
  Object.keys(BoxData.propTypes).map((k) => [
    k,
    d.memoryLayoutOf(BoxData, (b) => (b as Record<string, unknown>)[k]).offset /
      4
  ])
) as Record<BoxField, number>
