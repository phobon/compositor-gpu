// Param blocks (src/fx/params.ts): packing and the vec4 arrays (`count`)
// that tables such as layoutMorph's pairs use.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createParams } from '../../src/fx/params'

test('scalars and vectors pack at their WGSL offsets', () => {
  const b = createParams(
    {
      a: { type: 'f32', default: 1 },
      v: { type: 'vec4', default: [2, 3, 4, 5] }
    },
    () => {}
  )
  assert.equal(b.byteSize, 32)
  assert.deepEqual(Array.from(b.pack()), [1, 0, 0, 0, 2, 3, 4, 5])
  assert.match(b.wgsl, /v : vec4f/)
})

test('a vec4 array declares array<vec4f, n> and packs flat', () => {
  let writes = 0
  const b = createParams(
    {
      t: { type: 'f32', default: 0 },
      rows: { type: 'vec4', default: [1, 2, 3, 4], count: 3 }
    },
    () => {
      writes++
    }
  )
  assert.match(b.wgsl, /rows : array<vec4f, 3>/)
  // f32 at 0, the array aligned to 16 bytes: 4 + 3 × 16 bytes = 64.
  assert.equal(b.byteSize, 64)
  const v = b.values as unknown as { rows: number[] }
  // A one-element default fills every element.
  assert.deepEqual(
    Array.from(b.pack().slice(4)),
    [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]
  )
  v.rows = Array.from({ length: 12 }, (_, i) => i)
  assert.equal(writes, 1)
  assert.deepEqual(
    Array.from(b.pack().slice(4)),
    Array.from({ length: 12 }, (_, i) => i)
  )
  // Element writes mark it dirty too; a wrong length is ignored.
  v.rows[5] = 50
  assert.equal(b.pack()[9], 50)
  v.rows = [1, 2]
  assert.equal(b.pack()[4], 0)
})

test('count needs a vec4', () => {
  assert.throws(() =>
    createParams({ x: { type: 'f32', default: 0, count: 2 } }, () => {})
  )
})
