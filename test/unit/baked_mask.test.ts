// Baked distance-field masks (tools/bake_mask.ts, src/assets/mask_file.ts,
// src/fx/sdf_mask.ts): distances against exact ones, fill and stroke
// together, the half floats, the file round trip and the placement.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inflateSync } from 'node:zlib'
import { fromHalf, parseBakedMask, toHalf } from '../../src/assets/mask_file'
import { maskPlacement } from '../../src/fx/sdf_mask'
import { bakeMask, maskField } from '../../tools/bake_mask'
import { bakeSvg } from '../../tools/bake_svg'

const svg = (body: string, vb = '0 0 10 10') =>
  bakeSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${body}</svg>`
  )

/** The field at viewBox point (x, y), nearest texel. */
const at = (f: ReturnType<typeof maskField>, x: number, y: number): number => {
  const { box, width, height } = f.header
  const i = Math.min(width - 1, Math.floor(((x - box[0]) / box[2]) * width))
  const j = Math.min(height - 1, Math.floor(((y - box[1]) / box[3]) * height))
  return f.data[j * width + i] ?? Number.NaN
}

test('a circle: distance to its edge, negative inside, clamped', () => {
  const f = maskField(svg('<circle cx="5" cy="5" r="3"/>'), {
    resolution: 128,
    spread: 2
  })
  const { box, width, height } = f.header
  let worst = 0
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const x = box[0] + ((i + 0.5) / width) * box[2]
      const y = box[1] + ((j + 0.5) / height) * box[3]
      const want = Math.max(-2, Math.min(2, Math.hypot(x - 5, y - 5) - 3))
      worst = Math.max(worst, Math.abs((f.data[j * width + i] ?? 0) - want))
    }
  }
  assert.ok(worst < 0.01, `worst ${worst}`)
  assert.equal(f.header.spread, 2)
  assert.deepEqual(f.header.box.slice(0, 2), [-2, -2])
})

test('fill and stroke paint one region', () => {
  // A 4 x 4 square stroked 1 wide: its outer edge is 0.5 past the path.
  const f = maskField(
    svg(
      '<rect x="3" y="3" width="4" height="4" stroke="red" stroke-width="1"/>'
    ),
    { resolution: 200, spread: 3 }
  )
  assert.ok(Math.abs(at(f, 5, 5) + 2.5) < 0.06, `centre ${at(f, 5, 5)}`)
  assert.ok(Math.abs(at(f, 1.5, 5) - 1) < 0.06, `outside ${at(f, 1.5, 5)}`)
  // Unpainted shapes don't count.
  const none = maskField(svg('<rect width="10" height="10" fill="none"/>'), {
    resolution: 16
  })
  assert.ok(none.data.every((d) => d === Math.fround(none.header.spread)))
})

test('half floats', () => {
  for (const v of [0, 1, -1, 0.5, 2.5, -3.25, 1024, 65504]) {
    assert.equal(fromHalf(toHalf(v)), v)
  }
  assert.ok(Math.abs(fromHalf(toHalf(1.9)) - 1.9) < 1e-3)
  assert.equal(fromHalf(toHalf(1e6)), Number.POSITIVE_INFINITY)
})

test('a mask file round-trips', () => {
  const s = svg('<circle cx="5" cy="5" r="3"/>')
  const { bytes, header } = bakeMask(s, { resolution: 32 })
  const parsed = parseBakedMask(bytes)
  assert.deepEqual(parsed.header, header)
  const raw = inflateSync(parsed.deflated)
  const half = new Uint16Array(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)
  )
  const f = maskField(s, { resolution: 32 })
  assert.equal(half.length, f.data.length)
  f.data.forEach((d, i) => {
    assert.equal(half[i], toHalf(d))
  })
})

test('placement follows preserveAspectRatio', () => {
  const h = maskField(svg('<circle cx="5" cy="5" r="3"/>', '0 0 20 10'), {
    resolution: 16
  }).header
  // meet in 40 x 40: scale 2, centred vertically.
  assert.deepEqual(maskPlacement(h, 40, 40), {
    sx: 2,
    sy: 2,
    tx: 0,
    ty: 10,
    k: 2
  })
  // none: per-axis scales, distances by the smaller.
  assert.deepEqual(maskPlacement({ ...h, align: 'none' }, 40, 40), {
    sx: 2,
    sy: 4,
    tx: 0,
    ty: 0,
    k: 2
  })
  // slice: the larger scale.
  assert.equal(maskPlacement({ ...h, slice: true }, 40, 40).k, 4)
})
