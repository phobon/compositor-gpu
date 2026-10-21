// Image fade-in timing (src/images/image_fade.ts).
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ImageFades } from '../../src/images/image_fade'

test('an armed image starts transparent at its first upload', () => {
  const f = new ImageFades()
  f.duration = 200
  f.arm('a')
  assert.equal(f.alpha('a', 1000), 0)
  assert.equal(f.active, true)
})

test('the fade runs from the first upload, eased out, to 1', () => {
  const f = new ImageFades()
  f.duration = 200
  f.arm('a')
  f.alpha('a', 1000)
  assert.equal(f.alpha('a', 1100), 0.75)
  assert.equal(f.alpha('a', 1200), 1)
  assert.equal(f.active, false)
  assert.equal(f.alpha('a', 1300), 1)
})

test('images never armed draw at full opacity', () => {
  const f = new ImageFades()
  f.duration = 200
  assert.equal(f.alpha('b', 0), 1)
  assert.equal(f.alpha(undefined, 0), 1)
  assert.equal(f.active, false)
})

test('nothing is armed while the duration is 0', () => {
  const f = new ImageFades()
  f.arm('a')
  assert.equal(f.alpha('a', 0), 1)
  assert.equal(f.active, false)
})

test('setting the duration to 0 drops pending fades', () => {
  const f = new ImageFades()
  f.duration = 200
  f.arm('a')
  f.duration = 0
  assert.equal(f.active, false)
  assert.equal(f.alpha('a', 0), 1)
})
