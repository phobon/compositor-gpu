import tgpu from 'typegpu'
import * as d from 'typegpu/data'
import type { Externals } from '../gpu/frame'
import { floatOffsets, floatsOf, passExternals } from '../gpu/schema'

// The path pass's instance and edge layouts (docs/TYPEGPU.md).

/** One path record, as the path shader reads it. */
export const PathData = d
  .struct({
    /** a, b, c, d: linear part of path space -> record space. */
    xf0: d.vec4f,
    /** tx, ty, space (1 viewport), clip shape index. */
    xf1: d.vec4f,
    /** Quad bounds, path space: x0, y0, x1, y1. */
    box: d.vec4f,
    /** Straight RGBA, a 0 = none. */
    fill: d.vec4f,
    /** Straight RGBA, a 0 = none. */
    stroke: d.vec4f,
    /** Half stroke width, miter limit, cap, join. */
    style: d.vec4f,
    /** First fill edge, fill edges, first stroke edge, stroke edges. */
    fills: d.vec4f,
    /** First band, bands (0: none), first band y, bands per unit y. */
    bands: d.vec4f,
    /** minX, minY, maxX, maxY (record space). */
    clip: d.vec4f,
    /** Even-odd, 0, 0, 0. */
    flags: d.vec4f,
    _pad: d.vec4f
  })
  .$name('Path')

/** A stroke edge: ab = a, b; pf = previous point, flags (1 join at a, 2
 * cap at a, 4 cap at b), 0. */
export const StrokeEdgeData = d
  .struct({ ab: d.vec4f, pf: d.vec4f })
  .$name('StrokeEdge')

/** Bind group 1 of the path pass. */
export const pathLayout = tgpu
  .bindGroupLayout({
    paths: {
      storage: d.arrayOf(PathData),
      access: 'readonly',
      visibility: ['vertex', 'fragment']
    },
    /** Fill edges: a, b. */
    fill_edges: {
      storage: d.arrayOf(d.vec4f),
      access: 'readonly',
      visibility: ['vertex', 'fragment']
    },
    stroke_edges: {
      storage: d.arrayOf(StrokeEdgeData),
      access: 'readonly',
      visibility: ['vertex', 'fragment']
    },
    /** Per band: first fill index, fill indices, first stroke index,
     * stroke indices (into band_idx). */
    bands: {
      storage: d.arrayOf(d.vec4f),
      access: 'readonly',
      visibility: ['vertex', 'fragment']
    },
    /** Edge numbers relative to the record's first fill / stroke edge. */
    band_idx: {
      storage: d.arrayOf(d.u32),
      access: 'readonly',
      visibility: ['vertex', 'fragment']
    }
  })
  .$idx(1)

/** What the path shader names beyond the Frame items. */
export const PATH_EXTERNALS: Externals = passExternals(pathLayout, {
  Path: PathData,
  StrokeEdge: StrokeEdgeData
})

/** Floats per path record. */
export const FLOATS_PER_PATH = floatsOf(PathData)
/** Float offset of each Path field within a record. */
export const PATH_AT = floatOffsets(PathData)
/** Floats per stroke edge. */
export const FLOATS_PER_STROKE_EDGE = floatsOf(StrokeEdgeData)
