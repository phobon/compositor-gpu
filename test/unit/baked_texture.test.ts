// Baked effect-input textures (src/assets/texture_file.ts, tools/bake.ts,
// src/fx/textures.ts): the mip chain, the gradient filter, the file
// round trip, and the `textures` option's checks.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inflateSync } from 'node:zlib'
import { PNG } from 'pngjs'
import {
  fullLevels,
  levelSizes,
  mipChain,
  parseBakedTexture,
  splitLevels,
  unfilterLevels
} from '../../src/assets/texture_file'
import { textureList, texturesWgsl } from '../../src/fx/textures'
import { bakeTexture } from '../../tools/bake'

const texels = (
  w: number,
  h: number,
  f: (x: number, y: number) => number[]
) => {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out.set(f(x, y), (y * w + x) * 4)
    }
  }
  return out
}

test('level sizes halve down to 1 x 1', () => {
  assert.equal(fullLevels(256, 32), 9)
  assert.deepEqual(levelSizes(5, 3, 3), [
    [5, 3],
    [2, 1],
    [1, 1]
  ])
})

test('data mips average 2 x 2, an odd edge folding in', () => {
  // 3 x 2: columns 0..2 valued 0, 30, 90; level 1 is 1 x 1 over all six.
  const l0 = texels(3, 2, (x) => [[0, 30, 90][x] ?? 0, 0, 0, 255])
  const [, l1] = mipChain(l0, 3, 2, 'linear')
  assert.deepEqual([...(l1 ?? [])], [40, 0, 0, 255])
})

test('colour mips filter in linear light, weighted by alpha', () => {
  // Black and white: the linear-light mean is sRGB 188, not 128.
  const bw = texels(2, 1, (x) => (x ? [255, 255, 255, 255] : [0, 0, 0, 255]))
  assert.deepEqual(
    [...(mipChain(bw, 2, 1, 'srgb')[1] ?? [])],
    [188, 188, 188, 255]
  )
  // A transparent texel's colour doesn't bleed in.
  const half = texels(2, 1, (x) => (x ? [255, 0, 0, 255] : [0, 255, 0, 0]))
  assert.deepEqual(
    [...(mipChain(half, 2, 1, 'srgb')[1] ?? [])],
    [255, 0, 0, 128]
  )
})

test('a baked texture inflates and unfilters to its mip chain', () => {
  const png = new PNG({ width: 37, height: 19 })
  for (let i = 0; i < png.data.length; i++) {
    png.data[i] = (i * 7919 + (i >> 6) * 31) & 255
  }
  const want = mipChain(new Uint8Array(png.data), 37, 19, 'srgb')
  const { bytes, header } = bakeTexture(PNG.sync.write(png), 'srgb')
  assert.deepEqual(header, { width: 37, height: 19, levels: 6, color: 'srgb' })
  const parsed = parseBakedTexture(bytes)
  assert.deepEqual(parsed.header, header)
  const levels = splitLevels(
    header,
    new Uint8Array(inflateSync(parsed.deflated))
  )
  unfilterLevels(levels, header)
  assert.equal(levels.length, want.length)
  levels.forEach((l, k) => {
    assert.deepEqual([...l], [...(want[k] ?? [])], `level ${k}`)
  })
})

test('the textures option: WGSL names, at most four', () => {
  const t = { name: 'n', loaded: false, ready: Promise.resolve(false) }
  assert.deepEqual(
    textureList({ noise: t }, 'p').map(([n]) => n),
    ['noise']
  )
  assert.throws(() => textureList({ 'my-tex': t }, 'p'), /WGSL identifier/)
  assert.throws(
    () => textureList({ a: t, b: t, c: t, d: t, e: t }, 'p'),
    /at most 4/
  )
  const w = texturesWgsl(2, 5, ['noise', 'lut'])
  assert.match(w, /@group\(2\) @binding\(7\) var fx_tex_0/)
  assert.match(w, /@group\(2\) @binding\(8\) var fx_tex_1/)
  assert.match(w, /fn tex_lut_ready\(\) -> bool/)
  assert.equal(texturesWgsl(2, 5, []), '')
})
