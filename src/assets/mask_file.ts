// Baked distance-field masks (M5f; src/fx/README.md, Distance fields): an
// svg file's shape as a signed distance field computed offline
// (tools/bake_mask.ts), which `fx.sdf(el, { mask })` places over an
// element's content box and passes and layers read with `sdf(p)`, as a
// live field. Distances are in the svg's viewBox units (negative inside),
// clamped to +-spread, as half floats (r16float). Pure: no DOM.
//
// Layout (little-endian): "CGD1", version u32, header bytes u32, the
// header as UTF-8 JSON (BakedMaskHeader), zero padding to 4 bytes, then
// width x height f16s (rows top down) as one zlib (deflate) stream.

export const MASK_MAGIC = 0x31444743 // "CGD1"
export const MASK_VERSION = 1

export interface BakedMaskHeader {
  /** The svg's viewBox: x, y, width, height. */
  viewBox: [number, number, number, number]
  /** Its preserveAspectRatio (as BakedSvgHeader). */
  align: string
  slice: boolean
  /** The field's box, viewBox units: the viewBox grown by `spread`. */
  box: [number, number, number, number]
  width: number
  height: number
  /** viewBox units the field reaches past the shape. */
  spread: number
}

const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)

/** A float as IEEE half bits (round to nearest even). */
export function toHalf(v: number): number {
  f32[0] = v
  const x = u32[0] ?? 0
  const sign = (x >>> 16) & 0x8000
  const exp = (x >>> 23) & 0xff
  let mant = x & 0x7fffff
  if (exp === 0xff) {
    return sign | 0x7c00 | (mant ? 0x200 : 0)
  }
  const e = exp - 127 + 15
  if (e >= 0x1f) {
    return sign | 0x7c00
  }
  if (e <= 0) {
    if (e < -10) {
      return sign
    }
    mant |= 0x800000
    const shift = 14 - e
    const half = mant >>> shift
    const rest = mant & ((1 << shift) - 1)
    const mid = 1 << (shift - 1)
    return sign | (half + (rest > mid || (rest === mid && half & 1) ? 1 : 0))
  }
  let half = (e << 10) | (mant >>> 13)
  const rest = mant & 0x1fff
  if (rest > 0x1000 || (rest === 0x1000 && half & 1)) {
    half++
  }
  return sign | half
}

/** Half bits as a float. */
export function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >>> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) {
    return s * m * 2 ** -24
  }
  if (e === 0x1f) {
    return m ? Number.NaN : s * Number.POSITIVE_INFINITY
  }
  return s * (1 + m / 1024) * 2 ** (e - 15)
}

export function encodeBakedMask(
  header: BakedMaskHeader,
  deflated: Uint8Array
): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(header))
  const at = Math.ceil((12 + json.length) / 4) * 4
  const out = new Uint8Array(at + deflated.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, MASK_MAGIC, true)
  v.setUint32(4, MASK_VERSION, true)
  v.setUint32(8, json.length, true)
  out.set(json, 12)
  out.set(deflated, at)
  return out.buffer
}

/** A file's header and its deflated half floats. */
export function parseBakedMask(buffer: ArrayBuffer): {
  header: BakedMaskHeader
  deflated: Uint8Array
} {
  const v = new DataView(buffer)
  if (buffer.byteLength < 12 || v.getUint32(0, true) !== MASK_MAGIC) {
    throw new Error('not a baked mask (bad magic)')
  }
  const version = v.getUint32(4, true)
  if (version !== MASK_VERSION) {
    throw new Error(`baked mask version ${version}, expected ${MASK_VERSION}`)
  }
  const n = v.getUint32(8, true)
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 12, n))
  ) as BakedMaskHeader
  const at = Math.ceil((12 + n) / 4) * 4
  return { header, deflated: new Uint8Array(buffer, at) }
}
