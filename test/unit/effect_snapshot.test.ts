// Effect snapshot: the frame's view of the effect registries.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  type EffectRegistries,
  type SnapshotInput,
  snapshotEffects
} from '../../src/gpu/effect_snapshot'
import type {
  ExtraLayer,
  LayerTransform,
  MaterialEntry,
  RegionHandler
} from '../../src/gpu/graph'
import type { DrawBatch } from '../../src/scene/batches'
import type { OpacityGroup } from '../../src/scene/stacking'
import type { FrameContext } from '../../src/types'

const ctx: FrameContext = {
  time: 0,
  dt: 16,
  scrollX: 0,
  scrollY: 0,
  width: 1000,
  height: 900,
  canvasX: 0,
  canvasY: 0,
  canvasWidth: 1000,
  canvasHeight: 2700,
  pointer: null
}

function group(over: Partial<OpacityGroup> = {}): OpacityGroup {
  return {
    first: 0,
    last: 10,
    alpha: 1,
    bounds: { x: 0, y: 100, width: 200, height: 50 },
    vbounds: null,
    depth: 0,
    ...over
  }
}

function region(active: boolean, pad = 0): RegionHandler {
  return { active: () => active, pad: () => pad } as unknown as RegionHandler
}

function transform(over: Partial<LayerTransform> = {}): LayerTransform {
  return {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotate: 0,
    opacity: 1,
    originX: 0.5,
    originY: 0.5,
    ...over
  }
}

function material(active: boolean, changed: boolean): MaterialEntry {
  return {
    active: () => active,
    changed: () => changed
  } as unknown as MaterialEntry
}

function registries(over: Partial<EffectRegistries> = {}): EffectRegistries {
  return {
    extras: new Map(),
    regions: new Map(),
    transforms: new Map(),
    materials: new Map(),
    ...over
  }
}

const batches: DrawBatch[] = []

function input(over: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    scene: { groups: [], batches, version: 1, backdrops: [] },
    ctx,
    dpr: 1,
    dirty: false,
    settled: 0,
    pendingRows: false,
    ...over
  }
}

describe('effectOf', () => {
  test('an active region pass wins over a transform with its id', () => {
    const g = group({ region: 1 })
    const reg = registries({
      regions: new Map([[1, region(true)]]),
      transforms: new Map([[1, transform()]])
    })
    assert.equal(snapshotEffects(reg, input()).effectOf(g)?.kind, 'region')
  })

  test('an inactive region falls back to the transform', () => {
    const g = group({ region: 1 })
    const reg = registries({
      regions: new Map([[1, region(false)]]),
      transforms: new Map([[1, transform()]])
    })
    assert.equal(snapshotEffects(reg, input()).effectOf(g)?.kind, 'transform')
  })

  test('a group without an id has none', () => {
    assert.equal(snapshotEffects(registries(), input()).effectOf(group()), null)
  })
})

describe('content', () => {
  test('a key from the batch list, version, settle counter and materials', () => {
    const reg = registries({ materials: new Map([[7, material(true, false)]]) })
    const a = snapshotEffects(reg, input()).content
    assert.ok(a.now)
    assert.equal(a.now, a.commit)
    assert.equal(snapshotEffects(reg, input()).content.now, a.now)
    for (const over of [
      { scene: { groups: [], batches: [], version: 1, backdrops: [] } },
      { scene: { groups: [], batches, version: 2, backdrops: [] } },
      { settled: 1 }
    ]) {
      assert.notEqual(snapshotEffects(reg, input(over)).content.now, a.now)
    }
    const none = snapshotEffects(registries(), input()).content.now
    assert.notEqual(none, a.now)
  })

  test('no key when something draws differently this frame', () => {
    const cases: [EffectRegistries, Partial<SnapshotInput>][] = [
      [registries(), { dirty: true }],
      [
        registries(),
        { scene: { groups: [], batches, version: 1, backdrops: [{}] } }
      ],
      [
        registries({
          extras: new Map([[1, { active: () => true } as ExtraLayer]])
        }),
        {}
      ],
      [registries({ materials: new Map([[7, material(true, true)]]) }), {}]
    ]
    for (const [reg, over] of cases) {
      assert.equal(snapshotEffects(reg, input(over)).content.now, null)
    }
  })

  test('a changing material commits its key; an extra layer commits none', () => {
    const m = snapshotEffects(
      registries({ materials: new Map([[7, material(true, true)]]) }),
      input()
    ).content
    assert.ok(m.commit)
    const x = snapshotEffects(
      registries({
        extras: new Map([[1, { active: () => true } as ExtraLayer]])
      }),
      input()
    ).content
    assert.equal(x.commit, null)
  })

  test('nested or viewport-space transformed groups have no key', () => {
    const reg = registries({
      transforms: new Map([
        [1, transform()],
        [2, transform()]
      ])
    })
    const nested = [
      group({ region: 1, first: 0, last: 10 }),
      group({ region: 2, first: 2, last: 5 })
    ]
    const scene = { groups: nested, batches, version: 1, backdrops: [] }
    assert.equal(snapshotEffects(reg, input({ scene })).content.now, null)
    const fixed = [group({ region: 1, space: 'viewport' })]
    assert.equal(
      snapshotEffects(reg, input({ scene: { ...scene, groups: fixed } }))
        .content.now,
      null
    )
  })
})

describe('layer damage', () => {
  test("a moved group's rows where it is and where it would land", () => {
    const g = group({
      region: 1,
      box: { x: 0, y: 100, width: 200, height: 50 }
    })
    const reg = registries({
      transforms: new Map([[1, transform({ y: 300 })]])
    })
    const scene = { groups: [g], batches, version: 1, backdrops: [] }
    const { rows, key, live } = snapshotEffects(reg, input({ scene })).layers
    assert.deepEqual(rows, [
      [98, 152],
      [398, 452]
    ])
    assert.match(key, /^1:0,300,/)
    assert.equal(live, false)
  })

  test('an active region pass is live and padded', () => {
    const g = group({ region: 1 })
    const reg = registries({ regions: new Map([[1, region(true, 10)]]) })
    const scene = { groups: [g], batches, version: 1, backdrops: [] }
    const { rows, live } = snapshotEffects(reg, input({ scene })).layers
    assert.equal(live, true)
    assert.deepEqual(rows, [[88, 162]])
  })
})

describe('reuseKey', () => {
  test('null while anything draws differently every frame', () => {
    const scene = {
      groups: [group({ region: 1 })],
      batches,
      version: 1,
      backdrops: []
    }
    const cases: [EffectRegistries, Partial<SnapshotInput>][] = [
      [registries(), { pendingRows: true }],
      [
        registries({
          extras: new Map([[1, { active: () => true } as ExtraLayer]])
        }),
        {}
      ],
      [registries({ regions: new Map([[1, region(true)]]) }), { scene }],
      [registries({ materials: new Map([[7, material(true, true)]]) }), {}]
    ]
    for (const [reg, over] of cases) {
      assert.equal(snapshotEffects(reg, input(over)).reuseKey(), null)
    }
  })

  test('only transforms and regions on groups in the scene count', () => {
    const scene = {
      groups: [group({ region: 1 })],
      batches,
      version: 1,
      backdrops: []
    }
    const key = (t1: LayerTransform, t2: LayerTransform) =>
      snapshotEffects(
        registries({
          transforms: new Map([
            [1, t1],
            [2, t2]
          ]),
          regions: new Map([[2, region(true)]])
        }),
        input({ scene })
      ).reuseKey()
    const base = key(transform(), transform())
    assert.ok(base)
    // Group 2 isn't in the scene: its transform and region don't matter.
    assert.equal(key(transform(), transform({ x: 5 })), base)
    assert.notEqual(key(transform({ x: 5 }), transform()), base)
  })
})
