// Trigger tweens (src/fx/tween.ts): bezier and spring channels,
// retargeting from the current value, and when `done` runs.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Animator } from '../../src/fx/tween'

const LINEAR: [number, number, number, number] = [0, 0, 1, 1]

function rig(start: number[] = [0]) {
  const vals = new Map<string, number[]>([['a', start]])
  const anim = new Animator((k, v) => vals.set(k, v))
  const cur = (k: string) => vals.get(k) ?? [0]
  return { vals, anim, cur }
}

test('a bezier channel follows its curve and lands once', () => {
  const { vals, anim, cur } = rig()
  let done = 0
  anim.to({ a: [10] }, cur, { duration: 1, ease: LINEAR }, 0, () => done++)
  assert.equal(anim.step(500), true)
  assert.equal(vals.get('a')?.[0], 5)
  assert.equal(anim.step(1000), false)
  assert.deepEqual(vals.get('a'), [10])
  assert.equal(done, 1)
  assert.equal(anim.running, false)
})

test('delay holds the channel where it is', () => {
  const { vals, anim, cur } = rig([2])
  anim.to({ a: [4] }, cur, { duration: 1, delay: 0.5, ease: LINEAR }, 0)
  anim.step(400)
  assert.deepEqual(vals.get('a'), [2])
  anim.step(1000)
  assert.equal(vals.get('a')?.[0], 3)
})

test('a new goal starts from where the channel is; the old done is dropped', () => {
  const { vals, anim, cur } = rig()
  let first = 0
  let second = 0
  anim.to({ a: [10] }, cur, { duration: 1, ease: LINEAR }, 0, () => first++)
  anim.step(500)
  anim.to({ a: [0] }, cur, { duration: 1, ease: LINEAR }, 500, () => second++)
  anim.step(1000)
  assert.equal(vals.get('a')?.[0], 2.5)
  anim.step(1500)
  assert.deepEqual([first, second], [0, 1])
})

test('duration 0 writes at once and calls done', () => {
  const { vals, anim, cur } = rig()
  let done = 0
  anim.to({ a: [3, 4] }, cur, { duration: 0 }, 0, () => done++)
  assert.deepEqual(vals.get('a'), [3, 4])
  assert.equal(done, 1)
  assert.equal(anim.running, false)
})

test('a spring settles on its goal and a bouncy one overshoots', () => {
  for (const bounce of [0, 0.5]) {
    const { vals, anim, cur } = rig()
    const ease = { spring: { visualDuration: 0.3, bounce } }
    anim.to({ a: [1] }, cur, { ease }, 0)
    let peak = 0
    let t = 16
    for (; anim.step(t); t += 16) {
      peak = Math.max(peak, vals.get('a')?.[0] ?? 0)
      assert.ok(t < 5000, 'spring never settled')
    }
    assert.deepEqual(vals.get('a'), [1])
    if (bounce > 0) {
      assert.ok(peak > 1.05, `peak ${peak}`)
    } else {
      assert.ok(peak <= 1.0001, `peak ${peak}`)
    }
  }
})

test('a retargeted spring keeps its velocity', () => {
  const { vals, anim, cur } = rig()
  const ease = { spring: { visualDuration: 0.4 } }
  anim.to({ a: [100] }, cur, { ease }, 0)
  anim.step(100)
  const at = vals.get('a')?.[0] ?? 0
  anim.to({ a: [0] }, cur, { ease }, 100)
  anim.step(116)
  // Still moving up for a moment before it turns back.
  assert.ok((vals.get('a')?.[0] ?? 0) > at)
})

test('stop leaves the value and drops done', () => {
  const { vals, anim, cur } = rig()
  let done = 0
  anim.to({ a: [10] }, cur, { duration: 1, ease: LINEAR }, 0, () => done++)
  anim.step(200)
  anim.stop()
  assert.equal(anim.step(2000), false)
  assert.equal(vals.get('a')?.[0], 2)
  assert.equal(done, 0)
})
