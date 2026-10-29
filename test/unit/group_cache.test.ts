// Kept opacity-group textures (src/gpu/group_cache.ts): what changes a
// group's signature, what keeps it from being kept, and the entries'
// lifetime.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GroupTarget } from '../../src/gpu/composite'
import {
  type CacheContext,
  cacheKey,
  GroupCache
} from '../../src/gpu/group_cache'
import type { GroupPlace } from '../../src/gpu/group_plan'
import type { DrawBatch } from '../../src/scene/batches'
import type { Scene } from '../../src/scene/scene'
import type { OpacityGroup } from '../../src/scene/stacking'

const place = (over: Partial<GroupPlace> = {}): GroupPlace => ({
  w: 100,
  h: 80,
  sx: 2,
  sy: 2,
  ox: 10,
  oy: 20,
  px: 0,
  py: 0,
  kx: 1,
  ky: 1,
  xf: null,
  ...over
})

const box = (id: number, over: Record<string, unknown> = {}) => ({
  kind: 'box',
  id,
  z: id,
  ...over
})

const group = (over: Partial<OpacityGroup> = {}): OpacityGroup => ({
  first: 0,
  last: 2,
  alpha: 1,
  bounds: { x: 0, y: 0, width: 50, height: 40 },
  vbounds: null,
  depth: 0,
  key: { el: {} },
  ...over
})

function setup() {
  const g = group()
  const scene = {
    boxes: [box(1), box(2)],
    images: [],
    runs: [],
    cutouts: [],
    paths: [],
    backdrops: [],
    groups: [g]
  } as unknown as Scene
  const list: DrawBatch[] = [
    { kind: 'push', group: 0 },
    { layer: 'boxes', first: 0, count: 2 },
    { kind: 'pop', group: 0 }
  ]
  const ctx: CacheContext = {
    scene,
    list,
    dpr: 2,
    imagesVolatile: false,
    textVolatile: false
  }
  const released: GroupTarget[] = []
  const cache = new GroupCache((t) => released.push(t))
  return { g, scene, list, ctx, cache, released }
}

const target = (): GroupTarget =>
  ({ width: 128, height: 128, inUse: false, lastUsed: 0 }) as GroupTarget

test('the same group, records and place sign the same', () => {
  const { g, ctx, cache } = setup()
  const a = cache.signature(ctx, g, 0, 2, place(), 0, [])
  const b = cache.signature(ctx, g, 0, 2, place(), 0, [])
  assert.notEqual(a, null)
  assert.equal(a, b)
})

test('a record rebuilt the same keeps the signature (its id and z aside)', () => {
  const { g, scene, ctx, cache } = setup()
  const a = cache.signature(ctx, g, 0, 2, place(), 0, [])
  scene.boxes[1] = box(2, { id: 77, z: 40 }) as never
  assert.equal(cache.signature(ctx, g, 0, 2, place(), 0, []), a)
})

test('a changed record, a new place or filter changes the signature', () => {
  const { g, scene, ctx, cache } = setup()
  const a = cache.signature(ctx, g, 0, 2, place(), 0, [])
  scene.boxes[1] = box(2, { fill: { r: 1, g: 0, b: 0, a: 1 } }) as never
  assert.notEqual(cache.signature(ctx, g, 0, 2, place(), 0, []), a)
  const b = cache.signature(ctx, g, 0, 2, place(), 0, [])
  assert.notEqual(cache.signature(ctx, g, 0, 2, place({ oy: 21 }), 0, []), b)
  assert.notEqual(cache.signature(ctx, g, 0, 2, place(), 4, []), b)
  assert.notEqual(
    cache.signature(ctx, g, 0, 2, place(), 0, [
      { dx: 0, dy: 4, sigma: 6, color: [0, 0, 0, 0.3] }
    ]),
    b
  )
})

test('what changes without a new record keeps a group from being kept', () => {
  const { g, scene, list, ctx, cache } = setup()
  // A video.
  ;(scene as { images: unknown[] }).images = [
    { kind: 'image', id: 9, z: 9, dynamic: true }
  ]
  list.splice(2, 0, { layer: 'images', first: 0, count: 1 })
  assert.equal(cache.signature(ctx, g, 0, 3, place(), 0, []), null)
  // A material.
  const m = setup()
  m.list[1] = { layer: 'boxes', first: 0, count: 2, material: 3 }
  assert.equal(m.cache.signature(m.ctx, m.g, 0, 2, place(), 0, []), null)
  // Viewport-space members.
  const t = setup()
  assert.equal(
    t.cache.signature(
      t.ctx,
      group({ vbounds: { x: 0, y: 0, width: 1, height: 1 } }),
      0,
      2,
      place(),
      0,
      []
    ),
    null
  )
})

test('a nested group: its alpha is part of the parent', () => {
  const { scene, list, ctx, cache } = setup()
  const outer = group()
  const inner = group({ alpha: 0.5, depth: 1 })
  ;(scene as { groups: OpacityGroup[] }).groups = [outer, inner]
  list.splice(1, 0, { kind: 'push', group: 1 })
  list.splice(3, 0, { kind: 'pop', group: 1 })
  list[4] = { kind: 'pop', group: 0 }
  const a = cache.signature(ctx, outer, 0, 4, place(), 0, [])
  inner.alpha = 0.6
  assert.notEqual(cache.signature(ctx, outer, 0, 4, place(), 0, []), a)
})

test('entries: kept while matching, dropped when not or unused', () => {
  const { cache, released } = setup()
  const key = {}
  const t = target()
  cache.begin()
  assert.equal(cache.get(key, 1), null)
  cache.put(key, 1, t)
  assert.equal(t.held, true)
  cache.begin()
  assert.equal(cache.get(key, 1), t)
  assert.equal(cache.hits, 1)
  // Another signature: dropped (released to the pool).
  assert.equal(cache.get(key, 2), null)
  assert.equal(t.held, false)
  assert.deepEqual(released, [t])
  // Unused for longer than EVICT frames.
  const u = target()
  cache.put(key, 3, u)
  for (let i = 0; i < 300; i++) {
    cache.begin()
    cache.sweep()
  }
  assert.equal(cache.size, 0)
  assert.equal(u.held, false)
})

test('the key is the element, except for a pseudo-element node', () => {
  const el = {}
  assert.equal(cacheKey(group({ key: { el } })), el)
  const pseudo = { el, pseudo: true }
  assert.equal(cacheKey(group({ key: pseudo })), pseudo)
  assert.equal(cacheKey(group({ key: undefined })), undefined)
})

test('rendered afresh: why, a move told from a change', () => {
  const { g, scene, ctx, cache } = setup()
  const key = {}
  cache.begin()
  const a = cache.signature(ctx, g, 0, 2, place(), 0, []) as number
  assert.equal(cache.get(key, a), null)
  assert.equal(cache.reason, 'new')
  cache.put(key, a, target())
  const b = cache.signature(ctx, g, 0, 2, place({ oy: 30 }), 0, []) as number
  assert.equal(cache.get(key, b), null)
  assert.equal(cache.reason, 'moved')
  cache.put(key, b, target())
  scene.boxes[0] = box(1, { fill: { r: 0, g: 1, b: 0, a: 1 } }) as never
  const c = cache.signature(ctx, g, 0, 2, place({ oy: 30 }), 0, []) as number
  assert.equal(cache.get(key, c), null)
  assert.equal(cache.reason, 'changed')
  // Under a layer transform: kept; a new scale step is a move.
  assert.notEqual(
    cache.signature(ctx, g, 0, 2, place({ xf: [1, 0, 0, 1, 0, 0] }), 0, []),
    null
  )
  const d = cache.signature(ctx, g, 0, 2, place({ oy: 30, kx: 1.09 }), 0, [])
  assert.notEqual(d, c)
  assert.notEqual(d, null)
  cache.note(key, 'changed')
  cache.note(undefined, 'leaf')
  assert.deepEqual(cache.why, { changed: 1, leaf: 1 })
  assert.equal(cache.rendered.length, 2)
})

test('a leaf is steady once it signs the same two frames running', () => {
  const { cache } = setup()
  const key = {}
  cache.begin()
  assert.equal(cache.steady(key, 5), false)
  cache.begin()
  assert.equal(cache.steady(key, 5), true)
  cache.begin()
  assert.equal(cache.steady(key, 6), false)
  cache.begin()
  cache.sweep()
  cache.begin()
  assert.equal(cache.steady(key, 6), false)
})

test('a material signs with its key, or keeps the group from being kept', () => {
  const { g, list, ctx, cache } = setup()
  list[1] = { layer: 'boxes', first: 0, count: 2, material: 3 }
  let key: number | null = 1
  const c = { ...ctx, materialKey: () => key }
  const a = cache.signature(c, g, 0, 2, place(), 0, [])
  assert.notEqual(a, null)
  assert.equal(cache.signature(c, g, 0, 2, place(), 0, []), a)
  key = 0x10000 + 5
  assert.notEqual(cache.signature(c, g, 0, 2, place(), 0, []), a)
  key = null
  assert.equal(cache.signature(c, g, 0, 2, place(), 0, []), null)
  assert.equal(cache.reason, 'material')
})

test('a second group of the same element keeps one stand-in key', () => {
  const { cache } = setup()
  const el = {}
  const a = group({ key: { el } })
  const b = group({ key: { el } })
  cache.begin()
  const ka = cache.keyOf(a)
  const kb = cache.keyOf(b)
  assert.equal(ka, el)
  assert.notEqual(kb, el)
  assert.equal(cache.keyOf(b), kb)
  // Next frame, re-read (new reader nodes): the same keys.
  cache.begin()
  assert.equal(cache.keyOf(group({ key: { el } })), el)
  assert.equal(cache.keyOf(group({ key: { el } })), kb)
})

test('a nested isolated group signs with its key, or keeps the group from being kept', () => {
  const { scene, list, ctx, cache } = setup()
  const outer = group()
  const inner = group({ depth: 1, region: 7 })
  ;(scene as { groups: OpacityGroup[] }).groups = [outer, inner]
  list.splice(1, 0, { kind: 'push', group: 1 })
  list.splice(3, 0, { kind: 'pop', group: 1 })
  list[4] = { kind: 'pop', group: 0 }
  assert.equal(cache.signature(ctx, outer, 0, 4, place(), 0, []), null)
  assert.equal(cache.reason, 'nested region')
  let k: number | string | null = null
  const c = { ...ctx, nested: () => k }
  const idle = cache.signature(c, outer, 0, 4, place(), 0, [])
  assert.notEqual(idle, null)
  k = 12
  const a = cache.signature(c, outer, 0, 4, place(), 0, [])
  assert.notEqual(a, idle)
  assert.equal(cache.signature(c, outer, 0, 4, place(), 0, []), a)
  k = 13
  assert.notEqual(cache.signature(c, outer, 0, 4, place(), 0, []), a)
  k = 'nested region'
  assert.equal(cache.signature(c, outer, 0, 4, place(), 0, []), null)
})

test('radiusStep: half device px up to 8, then 5% steps', async () => {
  const { radiusStep } = await import('../../src/fx/presets/blur')
  assert.equal(radiusStep(0.3), 0)
  assert.equal(radiusStep(2.2), radiusStep(2.1))
  assert.notEqual(radiusStep(2.2), radiusStep(2.9))
  assert.equal(radiusStep(28), radiusStep(28.4))
  assert.notEqual(radiusStep(28), radiusStep(30))
})
