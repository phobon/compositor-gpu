// Read pass (src/dom/read_pass.ts): the per-read scroll snapshot, the
// per-space views and the per-pass caches.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ReadPass } from '../../src/dom/read_pass'

const client = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height }) as DOMRectReadOnly

test('document space adds the scroll; viewport space does not', () => {
  const pass = new ReadPass(10, 3000)
  assert.deepEqual(pass.at('doc').docRect(client(5, 20, 100, 50)), {
    x: 15,
    y: 3020,
    width: 100,
    height: 50
  })
  assert.deepEqual(pass.at('viewport').docRect(client(5, 20, 100, 50)), {
    x: 5,
    y: 20,
    width: 100,
    height: 50
  })
})

test('a view stays in its space whatever is read in between', () => {
  const pass = new ReadPass(0, 500)
  const doc = pass.at('doc')
  // A fixed subtree read in the middle (it used to switch a shared space).
  pass.at('viewport').docRect(client(0, 0, 1, 1))
  assert.equal(doc.docRect(client(0, 0, 1, 1)).y, 500)
  assert.equal(pass.at('doc'), doc)
})

test('both views share the pass; each pass starts empty', () => {
  const a = new ReadPass(0, 0)
  assert.equal(a.at('doc').pass, a)
  assert.equal(a.at('viewport').pass, a)
  a.stats.ranges += 3
  a.selectionText.set({} as Element, null)
  const b = new ReadPass(0, 0)
  assert.deepEqual(b.stats, { graphemes: 0, perGrapheme: 0, ranges: 0 })
  assert.equal(b.selectionText.size, 0)
  assert.deepEqual(b.ranges, [])
})
