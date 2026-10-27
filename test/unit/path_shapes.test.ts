// Shape morph data (src/fx/path_shapes.ts): resampling and alignment of
// two subpaths point to point.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  align,
  centroid,
  collapsed,
  resample,
  signedArea
} from '../../src/fx/path_shapes'

const square = (x: number, y: number, s: number, cw = true): Float32Array =>
  new Float32Array(
    cw
      ? [x, y, x + s, y, x + s, y + s, x, y + s]
      : [x, y, x, y + s, x + s, y + s, x + s, y]
  )

const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-4

test('a closed loop resamples evenly round its perimeter', () => {
  const r = resample(square(0, 0, 10), true, 8)
  assert.equal(r.length, 16)
  // Perimeter 40 in 8 steps of 5: corners and midpoints.
  const want = [0, 0, 5, 0, 10, 0, 10, 5, 10, 10, 5, 10, 0, 10, 0, 5]
  for (const [i, v] of want.entries()) {
    assert.ok(close(r[i] ?? Number.NaN, v), `${i}`)
  }
})

test('an open polyline keeps both ends', () => {
  const r = resample(new Float32Array([0, 0, 10, 0, 10, 10]), false, 5)
  assert.deepEqual(Array.from(r), [0, 0, 5, 0, 10, 0, 10, 5, 10, 10])
})

test('alignment matches winding and picks the least-travel start', () => {
  const a = resample(square(0, 0, 10), true, 8)
  // The same square drawn the other way round and started elsewhere,
  // moved: aligned, it pairs corner to corner with a.
  const b = resample(square(100, 50, 10, false), true, 8)
  const c = align(a, b, true)
  assert.equal(Math.sign(signedArea(c)), Math.sign(signedArea(a)))
  for (let i = 0; i < 8; i++) {
    assert.ok(close((c[2 * i] ?? 0) - (a[2 * i] ?? 0), 100))
    assert.ok(close((c[2 * i + 1] ?? 0) - (a[2 * i + 1] ?? 0), 50))
  }
})

test('a collapsed subpath sits at one point', () => {
  const r = collapsed(3, 4, 6)
  assert.deepEqual(centroid(r), [3, 4])
  assert.equal(signedArea(r), 0)
})
