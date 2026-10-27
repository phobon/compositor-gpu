// Bake an svg file into a distance-field mask (M5f;
// src/assets/mask_file.ts): the signed distance from each texel centre to
// what the svg paints (every filled or stroked shape, colours ignored),
// in viewBox units, negative inside, clamped to +-spread. Outlines come
// from the baked svg's path tapes (tools/bake_svg.ts), flattened finely
// for the field's resolution. Fills follow their fill rule; strokes are
// their centreline grown by half the width with round caps and joins
// (miters and square caps come out rounded). Brute force: every texel
// against every segment, fine at mask sizes.

import { deflateSync } from 'node:zlib'
import {
  type BakedMaskHeader,
  encodeBakedMask,
  toHalf
} from '../src/assets/mask_file'
import type { BakedSvg } from '../src/assets/vector_file'
import { Flat, maxScale, replayTape } from '../src/paths/path_data'

export interface MaskOptions {
  /** Texels on the field's longer side. Default 256. */
  resolution?: number
  /** viewBox units the field reaches past the shape. Default 8% of the
   * viewBox's longer side. */
  spread?: number
}

interface Segs {
  /** x0 y0 x1 y1 per segment. */
  s: Float64Array
  n: number
}

/** The contours' segments: `which` 'stroke' as drawn (open subpaths
 * open), 'fill' closed, 'closing' only the edges filling adds. */
const segsOf = (
  pts: number[],
  contours: number[],
  which: 'stroke' | 'fill' | 'closing'
): Segs => {
  const out: number[] = []
  for (let k = 0; k + 2 < contours.length; k += 3) {
    const first = contours[k] ?? 0
    const count = contours[k + 1] ?? 0
    const open = contours[k + 2] !== 1
    const from = which === 'closing' ? (open ? count - 1 : count) : 0
    const last = which === 'stroke' && open ? count - 1 : count
    for (let i = from; i < last; i++) {
      const a = first + i
      const b = first + ((i + 1) % count)
      out.push(
        pts[2 * a] ?? 0,
        pts[2 * a + 1] ?? 0,
        pts[2 * b] ?? 0,
        pts[2 * b + 1] ?? 0
      )
    }
  }
  return { s: Float64Array.from(out), n: out.length / 4 }
}

/** Distance from (px, py) to the nearest segment. */
function nearest(g: Segs, px: number, py: number): number {
  let best = Number.POSITIVE_INFINITY
  const s = g.s
  for (let i = 0; i < g.n; i++) {
    const x0 = s[4 * i] ?? 0
    const y0 = s[4 * i + 1] ?? 0
    const dx = (s[4 * i + 2] ?? 0) - x0
    const dy = (s[4 * i + 3] ?? 0) - y0
    const l2 = dx * dx + dy * dy
    let t = l2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const ex = x0 + t * dx - px
    const ey = y0 + t * dy - py
    const d = ex * ex + ey * ey
    if (d < best) {
      best = d
    }
  }
  return Math.sqrt(best)
}

/** Winding number of the closed segments around (px, py). */
function winding(g: Segs, px: number, py: number): number {
  let w = 0
  const s = g.s
  for (let i = 0; i < g.n; i++) {
    const x0 = s[4 * i] ?? 0
    const y0 = s[4 * i + 1] ?? 0
    const x1 = s[4 * i + 2] ?? 0
    const y1 = s[4 * i + 3] ?? 0
    if (y0 <= py) {
      if (y1 > py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) > 0) {
        w++
      }
    } else if (y1 <= py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) < 0) {
      w--
    }
  }
  return w
}

const painted = (c: string, a: number): boolean =>
  c !== 'none' && c !== 'transparent' && a > 0

/** The field's header and its distances (row-major, top down). */
export function maskField(
  svg: BakedSvg,
  opts: MaskOptions = {}
): { header: BakedMaskHeader; data: Float32Array } {
  const [vx, vy, vw, vh] = svg.viewBox
  const spread = opts.spread ?? 0.08 * Math.max(vw, vh)
  const res = Math.max(8, Math.round(opts.resolution ?? 256))
  const bw = vw + 2 * spread
  const bh = vh + 2 * spread
  const t = Math.max(bw, bh) / res
  const width = Math.max(1, Math.round(bw / t))
  const height = Math.max(1, Math.round(bh / t))
  const box: [number, number, number, number] = [
    vx - spread,
    vy - spread,
    width * t,
    height * t
  ]
  // Each shape's fill edges and stroke centreline, viewBox units.
  const shapes = svg.shapes.flatMap((sh) => {
    const fill = painted(sh.fill, sh.opacity * sh.fillOpacity)
    const stroke =
      sh.strokeWidth > 0 && painted(sh.stroke, sh.opacity * sh.strokeOpacity)
    if (!fill && !stroke) {
      return []
    }
    const flat = new Flat(sh.m, t / 16)
    replayTape(svg.tape, flat, sh.start, sh.end)
    flat.end(false)
    return [
      {
        fill: fill ? segsOf(flat.pts, flat.contours, 'fill') : null,
        closing: segsOf(flat.pts, flat.contours, 'closing'),
        evenOdd: sh.evenOdd,
        stroke: stroke ? segsOf(flat.pts, flat.contours, 'stroke') : null,
        half: (sh.strokeWidth * maxScale(sh.m)) / 2
      }
    ]
  })
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const py = box[1] + (y + 0.5) * t
    for (let x = 0; x < width; x++) {
      const px = box[0] + (x + 0.5) * t
      let d = spread
      for (const s of shapes) {
        // The painted region is fill and stroke together: inside the
        // fill, the way out crosses a stroked edge (its centreline plus
        // half the width) or an edge only filling closes.
        const es =
          s.stroke && s.stroke.n > 0
            ? nearest(s.stroke, px, py)
            : Number.POSITIVE_INFINITY
        let sd = es - s.half
        if (s.fill && s.fill.n > 0) {
          const w = winding(s.fill, px, py)
          const inside = s.evenOdd ? (w & 1) !== 0 : w !== 0
          if (inside) {
            sd = s.stroke
              ? -Math.min(es + s.half, nearest(s.closing, px, py))
              : -nearest(s.fill, px, py)
          } else {
            sd = Math.min(sd, nearest(s.fill, px, py))
          }
        }
        d = Math.min(d, sd)
      }
      data[y * width + x] = Math.max(-spread, Math.min(spread, d))
    }
  }
  return {
    header: {
      viewBox: svg.viewBox,
      align: svg.align,
      slice: svg.slice,
      box,
      width,
      height,
      spread
    },
    data
  }
}

/** A mask file for `svg`. */
export function bakeMask(
  svg: BakedSvg,
  opts: MaskOptions = {}
): { bytes: ArrayBuffer; header: BakedMaskHeader } {
  const { header, data } = maskField(svg, opts)
  const half = new Uint8Array(data.length * 2)
  const v = new DataView(half.buffer)
  data.forEach((d, i) => {
    v.setUint16(2 * i, toHalf(d), true)
  })
  return {
    bytes: encodeBakedMask(
      header,
      new Uint8Array(deflateSync(half, { level: 9 }))
    ),
    header
  }
}
