// Config files for the Edit tab (src/editor/file.ts): parsing,
// writing and diffs.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  describeDiff,
  diffConfigs,
  parseConfig,
  serialize
} from '../../src/editor/file'
import type { FxConfig } from '../../src/fx/config'

const cfg: FxConfig = {
  version: 1,
  page: [{ id: 'v', effect: 'vignette', params: { amount: 0.5 } }],
  elements: [
    { match: { fx: 'hero' }, effects: [{ id: 'h', effect: 'spotlight' }] }
  ]
}

test('a config round-trips through its file text', () => {
  const text = serialize(cfg)
  assert.ok(text.endsWith('}\n'))
  assert.match(text, /\n {2}"version": 1,/)
  assert.deepEqual(parseConfig(text), cfg)
})

test('files that aren’t configs say why', () => {
  assert.throws(() => parseConfig('{'), /not JSON/)
  assert.throws(() => parseConfig('[]'), /not a JSON object/)
  assert.throws(() => parseConfig('{"version":2}'), /version 2/)
  assert.throws(
    () => parseConfig('{"version":1,"page":[{"effect":"x"}]}'),
    /page: an effect without/
  )
  assert.throws(
    () => parseConfig('{"version":1,"elements":[{"effects":[]}]}'),
    /elements\[0\] has no match/
  )
  assert.deepEqual(parseConfig('{"version":1}'), { version: 1 })
})

test('diffs by effect id', () => {
  const next: FxConfig = {
    version: 1,
    page: [{ id: 'v', effect: 'vignette', params: { amount: 0.7 } }],
    elements: [
      { match: { fx: 'hero2' }, effects: [{ id: 'h', effect: 'spotlight' }] },
      { match: { fx: 'x' }, effects: [{ id: 'n', effect: 'glow' }] }
    ]
  }
  const d = diffConfigs(cfg, next)
  assert.deepEqual(d, { added: ['n'], removed: [], changed: ['v', 'h'] })
  assert.equal(describeDiff(d), '+1 ~2')
  assert.equal(describeDiff(diffConfigs(cfg, cfg)), '')
  assert.deepEqual(diffConfigs(cfg, { version: 1 }).removed, ['v', 'h'])
})
