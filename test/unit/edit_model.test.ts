// The Edit tab's config changes and undo history (src/editor/edits.ts).
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addEffect,
  findEffect,
  History,
  removeEffect,
  setEnabled,
  setParam,
  setTrigger,
  uniqueId
} from '../../src/editor/edits'
import type { FxConfig } from '../../src/fx/config'

const empty: FxConfig = { version: 1 }

test('adding joins an entry with the same match; removing prunes it', () => {
  let c = addEffect(empty, { fx: 'hero' }, 'spotlight', 'a')
  c = addEffect(c, { fx: 'hero' }, 'glow', 'b')
  c = addEffect(c, { selector: '.x' }, 'blur', 'c')
  c = addEffect(c, null, 'vignette', 'd')
  assert.equal(c.elements?.length, 2)
  assert.deepEqual(
    c.elements?.[0]?.effects.map((e) => e.id),
    ['a', 'b']
  )
  assert.deepEqual(findEffect(c, 'd')?.match, null)
  assert.deepEqual(findEffect(c, 'b')?.match, { fx: 'hero' })
  c = removeEffect(removeEffect(c, 'c'), 'd')
  assert.equal(c.elements?.length, 1)
  assert.equal(c.page, undefined)
  assert.deepEqual(empty, { version: 1 }, 'input untouched')
})

test('unique ids', () => {
  const c = addEffect(addEffect(empty, null, 'blur', 'x'), null, 'blur', 'x-2')
  assert.equal(uniqueId(c, 'y'), 'y')
  assert.equal(uniqueId(c, 'x'), 'x-3')
})

test('params, enabled and triggers set and unset', () => {
  let c = addEffect(empty, { fx: 'a' }, 'probe', 'p')
  c = setParam(c, 'p', 'a', 2)
  c = setParam(c, 'p', 'tint', '#ff0000')
  assert.deepEqual(findEffect(c, 'p')?.effect.params, { a: 2, tint: '#ff0000' })
  c = setParam(setParam(c, 'p', 'a', undefined), 'p', 'tint', undefined)
  assert.equal(findEffect(c, 'p')?.effect.params, undefined)
  c = setEnabled(c, 'p', false)
  assert.equal(findEffect(c, 'p')?.effect.enabled, false)
  c = setEnabled(c, 'p', true)
  assert.equal(findEffect(c, 'p')?.effect.enabled, undefined)
  c = setTrigger(c, 'p', 5, { on: 'click', play: 'toggle' })
  c = setTrigger(c, 'p', 1, { on: 'load', to: 'rest' })
  assert.deepEqual(
    findEffect(c, 'p')?.effect.triggers?.map((t) => t.on),
    ['click', 'load']
  )
  c = setTrigger(setTrigger(c, 'p', 0, null), 'p', 0, null)
  assert.equal(findEffect(c, 'p')?.effect.triggers, undefined)
})

test('undo and redo; a drag coalesces', () => {
  const h = new History()
  const c0 = empty
  const c1 = addEffect(c0, null, 'blur', 'b')
  h.push(c0, undefined, 0)
  const c2 = setParam(c1, 'b', 'radius', 1)
  h.push(c1, 'b.radius', 100)
  const c3 = setParam(c2, 'b', 'radius', 2)
  h.push(c2, 'b.radius', 200)
  const c4 = setParam(c3, 'b', 'radius', 3)
  h.push(c3, 'b.radius', 5000)
  assert.deepEqual(h.undo(c4), c3, 'after the window: its own step')
  assert.deepEqual(h.undo(c3), c1, 'the drag is one step')
  assert.deepEqual(h.undo(c1), c0)
  assert.equal(h.undo(c0), null)
  assert.deepEqual(h.redo(c0), c1)
  assert.deepEqual(h.redo(c1), c3)
  h.push(c3, undefined, 6000)
  assert.equal(h.canRedo, false, 'a new change drops redo')
})
