// Baked effect-input textures (M5f; docs/EFFECTS.md, textures): an image
// as RGBA8 texels with its whole mip chain built offline (tools/bake.ts),
// so the runtime uploads the levels as they are (writeTexture: no image
// decode, colour management or premultiplication on the way, and no
// mipmap pass). Pure: no DOM.
//
// Layout (little-endian): "CGT1", version u32, header bytes u32, the
// header as UTF-8 JSON (BakedTextureHeader), zero padding to 4 bytes,
// then every level's texels (level 0 first, rows top down, 4 bytes a
// texel), each byte stored as its difference from the gradient
// prediction left + above - above-left (mod 256, per channel; PNG's idea,
// about half the size of raw texels deflated), as one zlib (deflate)
// stream, which the browser inflates with DecompressionStream('deflate')
// before unfilterLevels.

export const TEXTURE_MAGIC = 0x31544743 // "CGT1"
export const TEXTURE_VERSION = 1

/** How the mip chain is filtered: 'srgb' for colour (in linear light,
 * weighted by alpha), 'linear' for data (noise, normal and displacement
 * maps, LUTs; plain averages). Either way texels are sampled as stored:
 * colour sRGB-encoded, as the page's pixels are in every pass. */
export type TextureColor = 'srgb' | 'linear'

export interface BakedTextureHeader {
  width: number
  height: number
  levels: number
  color: TextureColor
}

/** Each level's size, level 0 first. */
export function levelSizes(
  width: number,
  height: number,
  levels: number
): [number, number][] {
  const out: [number, number][] = []
  for (let k = 0; k < levels; k++) {
    out.push([Math.max(1, width >> k), Math.max(1, height >> k)])
  }
  return out
}

/** Levels in a full chain down to 1 × 1. */
export const fullLevels = (w: number, h: number): number =>
  Math.floor(Math.log2(Math.max(w, h, 1))) + 1

const toLinear = (c: number): number => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const toSrgb = (v: number): number => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, c)) * 255)
}

/**
 * The mip chain of `rgba` (straight alpha), level 0 included: each level
 * a 2 × 2 box filter of the one above (an odd last row or column folds
 * into its neighbour). 'srgb' filters in linear light weighted by alpha;
 * 'linear' averages the stored values.
 */
export function mipChain(
  rgba: Uint8Array,
  width: number,
  height: number,
  color: TextureColor
): Uint8Array[] {
  const out: Uint8Array[] = [rgba]
  let src = rgba
  let w = width
  let h = height
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1)
    const nh = Math.max(1, h >> 1)
    const dst = new Uint8Array(nw * nh * 4)
    for (let y = 0; y < nh; y++) {
      // Source rows (and columns) folding into this texel.
      const y0 = Math.min(h - 1, 2 * y)
      const y1 = y === nh - 1 ? h - 1 : Math.min(h - 1, 2 * y + 1)
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(w - 1, 2 * x)
        const x1 = x === nw - 1 ? w - 1 : Math.min(w - 1, 2 * x + 1)
        const acc = [0, 0, 0, 0]
        let n = 0
        for (let sy = y0; sy <= y1; sy++) {
          for (let sx = x0; sx <= x1; sx++) {
            const i = (sy * w + sx) * 4
            const a = (src[i + 3] ?? 0) / 255
            if (color === 'srgb') {
              for (let c = 0; c < 3; c++) {
                acc[c] = (acc[c] ?? 0) + toLinear(src[i + c] ?? 0) * a
              }
              acc[3] = (acc[3] ?? 0) + a
            } else {
              for (let c = 0; c < 4; c++) {
                acc[c] = (acc[c] ?? 0) + (src[i + c] ?? 0)
              }
            }
            n++
          }
        }
        const o = (y * nw + x) * 4
        if (color === 'srgb') {
          const a = (acc[3] ?? 0) / n
          for (let c = 0; c < 3; c++) {
            dst[o + c] = a > 0 ? toSrgb((acc[c] ?? 0) / n / a) : 0
          }
          dst[o + 3] = Math.round(a * 255)
        } else {
          for (let c = 0; c < 4; c++) {
            dst[o + c] = Math.round((acc[c] ?? 0) / n)
          }
        }
      }
    }
    out.push(dst)
    src = dst
    w = nw
    h = nh
  }
  return out
}

/** Replace each level's bytes by their gradient residuals, in place
 * (back to front, so predictions read original bytes). */
export function filterLevels(
  levels: Uint8Array[],
  h: BakedTextureHeader
): void {
  levelSizes(h.width, h.height, h.levels).forEach(([w, hh], k) => {
    const l = levels[k] as Uint8Array
    const row = w * 4
    for (let i = hh * row - 1; i >= 0; i--) {
      const x = i % row >= 4
      const y = i >= row
      const left = x ? (l[i - 4] ?? 0) : 0
      const up = y ? (l[i - row] ?? 0) : 0
      const ul = x && y ? (l[i - row - 4] ?? 0) : 0
      l[i] = ((l[i] ?? 0) - left - up + ul) & 255
    }
  })
}

/** Undo filterLevels, in place (front to back). */
export function unfilterLevels(
  levels: Uint8Array[],
  h: BakedTextureHeader
): void {
  levelSizes(h.width, h.height, h.levels).forEach(([w, hh], k) => {
    const l = levels[k] as Uint8Array
    const row = w * 4
    const n = hh * row
    for (let i = 0; i < n; i++) {
      const x = i % row >= 4
      const y = i >= row
      const left = x ? (l[i - 4] ?? 0) : 0
      const up = y ? (l[i - row] ?? 0) : 0
      const ul = x && y ? (l[i - row - 4] ?? 0) : 0
      l[i] = ((l[i] ?? 0) + left + up - ul) & 255
    }
  })
}

/** Assemble a file from its header and the deflated texels. */
export function encodeBakedTexture(
  header: BakedTextureHeader,
  deflated: Uint8Array
): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(header))
  const at = Math.ceil((12 + json.length) / 4) * 4
  const out = new Uint8Array(at + deflated.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, TEXTURE_MAGIC, true)
  v.setUint32(4, TEXTURE_VERSION, true)
  v.setUint32(8, json.length, true)
  out.set(json, 12)
  out.set(deflated, at)
  return out.buffer
}

/** A file's header and its deflated texels (inflate them, then
 * `splitLevels`). */
export function parseBakedTexture(buffer: ArrayBuffer): {
  header: BakedTextureHeader
  deflated: Uint8Array
} {
  const v = new DataView(buffer)
  if (buffer.byteLength < 12 || v.getUint32(0, true) !== TEXTURE_MAGIC) {
    throw new Error('not a baked texture (bad magic)')
  }
  const version = v.getUint32(4, true)
  if (version !== TEXTURE_VERSION) {
    throw new Error(
      `baked texture version ${version}, expected ${TEXTURE_VERSION}`
    )
  }
  const n = v.getUint32(8, true)
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 12, n))
  ) as BakedTextureHeader
  const at = Math.ceil((12 + n) / 4) * 4
  return { header, deflated: new Uint8Array(buffer, at) }
}

/** The inflated texels as one array per level. */
export function splitLevels(
  h: BakedTextureHeader,
  texels: Uint8Array
): Uint8Array[] {
  const out: Uint8Array[] = []
  let at = 0
  for (const [w, hh] of levelSizes(h.width, h.height, h.levels)) {
    const n = w * hh * 4
    if (at + n > texels.length) {
      throw new Error('baked texture: texels end early')
    }
    out.push(texels.subarray(at, at + n))
    at += n
  }
  return out
}
