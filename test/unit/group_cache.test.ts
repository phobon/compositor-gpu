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

test('a replaced record, a new place or filter changes the signature', () => {
  const { g, scene, ctx, cache } = setup()
  const a = cache.signature(ctx, g, 0, 2, place(), 0, [])
  scene.boxes[1] = box(2) as never
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
  // Under a layer transform, or viewport-space members.
  const t = setup()
  assert.equal(
    t.cache.signature(
      t.ctx,
      t.g,
      0,
      2,
      place({ xf: [1, 0, 0, 1, 0, 0] }),
      0,
      []
    ),
    null
  )
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
