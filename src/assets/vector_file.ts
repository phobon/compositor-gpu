// Baked svg files (M5f; docs/INTEGRATION.md, Baked assets): an svg file
// as the bake tool resolved it (tools/bake_svg.ts), so an
// `<img data-gpu-vector src="x.svg">` draws as vectors without the
// runtime parsing the file: its viewBox, and per painted shape, in paint
// order, the shape's user space -> viewBox space matrix, its resolved
// paint, and its outline as a path tape (paths/path_data.ts) that the
// runtime flattens at the on-screen scale, exactly as it flattens an
// inline svg's. Pure: no DOM.
//
// Layout (little-endian): "CGV1", version u32, header bytes u32, the
// header as UTF-8 JSON (BakedSvgHeader), zero padding to 8 bytes, then
// the tape: f64s to the end.

import type { LineCap, LineJoin } from '../scene/records'

export const VECTOR_MAGIC = 0x31564743 // "CGV1"
export const VECTOR_VERSION = 1

export type Affine6 = [number, number, number, number, number, number]

export interface BakedShape {
  /** User space -> the root's user space (viewBox coordinates). */
  m: Affine6
  /** CSS paint, 'none' or a colour (currentColor resolved). */
  fill: string
  stroke: string
  opacity: number
  fillOpacity: number
  strokeOpacity: number
  /** User units. */
  strokeWidth: number
  cap: LineCap
  join: LineJoin
  miterLimit: number
  evenOdd: boolean
  /** The outline: tape[start, end). */
  start: number
  end: number
}

export interface BakedSvgHeader {
  /** x, y, width, height. */
  viewBox: [number, number, number, number]
  /** preserveAspectRatio: 'none' or xMinYMin ... xMaxYMax. */
  align: string
  slice: boolean
  shapes: BakedShape[]
}

export interface BakedSvg extends BakedSvgHeader {
  tape: Float64Array
}

export function encodeBakedSvg(svg: BakedSvg): ArrayBuffer {
  const { tape, ...header } = svg
  const json = new TextEncoder().encode(JSON.stringify(header))
  const at = Math.ceil((12 + json.length) / 8) * 8
  const out = new ArrayBuffer(at + tape.length * 8)
  const v = new DataView(out)
  v.setUint32(0, VECTOR_MAGIC, true)
  v.setUint32(4, VECTOR_VERSION, true)
  v.setUint32(8, json.length, true)
  new Uint8Array(out, 12, json.length).set(json)
  for (let k = 0; k < tape.length; k++) {
    v.setFloat64(at + 8 * k, tape[k] ?? 0, true)
  }
  return out
}

export function decodeBakedSvg(buffer: ArrayBuffer): BakedSvg {
  const v = new DataView(buffer)
  if (buffer.byteLength < 12 || v.getUint32(0, true) !== VECTOR_MAGIC) {
    throw new Error('not a baked svg (bad magic)')
  }
  const version = v.getUint32(4, true)
  if (version !== VECTOR_VERSION) {
    throw new Error(`baked svg version ${version}, expected ${VECTOR_VERSION}`)
  }
  const n = v.getUint32(8, true)
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 12, n))
  ) as BakedSvgHeader
  const at = Math.ceil((12 + n) / 8) * 8
  const tape = new Float64Array((buffer.byteLength - at) / 8)
  for (let k = 0; k < tape.length; k++) {
    tape[k] = v.getFloat64(at + 8 * k, true)
  }
  return { ...header, tape }
}

/** The viewBox -> viewport (CSS px from the content box's corner) map
 * for a `w` x `h` viewport, per preserveAspectRatio (null for `slice`
 * with a different aspect: the image would be clipped). */
export function viewBoxMap(
  svg: BakedSvgHeader,
  w: number,
  h: number
): Affine6 | null {
  const [vx, vy, vw, vh] = svg.viewBox
  if (vw <= 0 || vh <= 0) {
    return null
  }
  let sx = w / vw
  let sy = h / vh
  if (svg.align === 'none') {
    return [sx, 0, 0, sy, 0 - vx * sx, 0 - vy * sy]
  }
  if (svg.slice && Math.abs(sx - sy) > 1e-6 * Math.max(sx, sy)) {
    return null
  }
  const s = Math.min(sx, sy)
  sx = s
  sy = s
  const ax = svg.align.slice(1, 4) // Min / Mid / Max
  const ay = svg.align.slice(5, 8)
  const k = (a: string): number => (a === 'Min' ? 0 : a === 'Max' ? 1 : 0.5)
  const tx = (w - vw * s) * k(ax) - vx * s
  const ty = (h - vh * s) * k(ay) - vy * s
  return [s, 0, 0, s, tx, ty]
}
