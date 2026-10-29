// Group planning (src/gpu/group_plan.ts): what happens to each opacity
// group drawn into a target, and how leaves pack into a shared texture.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { GroupEffect } from '../../src/gpu/effect_snapshot'
import type { LayerTransform, RegionHandler } from '../../src/gpu/graph'
import {
  ATLAS_GUTTER,
  type GroupStep,
  type Leaf,
  type PlanInput,
  type PlanParent,
  packGroups,
  planLevel,
  stepUp
} from '../../src/gpu/group_plan'
import { layerAffine } from '../../src/gpu/layer_geometry'
import type { DrawBatch } from '../../src/scene/batches'
import type { GroupFilter } from '../../src/scene/filter'
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
  canvasHeight: 2000,
  pointer: null
}

/** The main target: 1000 × 2000 CSS px at dpr 1. */
const main: PlanParent = { ox: 0, oy: 0, sx: 1, sy: 1, devW: 1000, devH: 2000 }

function group(y: number, over: Partial<OpacityGroup> = {}): OpacityGroup {
  return {
    first: 0,
    last: 1,
    alpha: 0.5,
    bounds: { x: 100, y, width: 200, height: 100 },
    vbounds: null,
    depth: 0,
    ...over
  }
}

const draw: DrawBatch = { layer: 'boxes', first: 0, count: 1 }
const push = (group: number): DrawBatch => ({ kind: 'push', group })
const pop = (group: number): DrawBatch => ({ kind: 'pop', group })

function input(
  list: DrawBatch[],
  groups: OpacityGroup[],
  over: Partial<PlanInput> = {},
  effects: Map<number, GroupEffect> = new Map()
): PlanInput {
  return {
    list,
    groups,
    effectOf: (g) => (g ? (effects.get(groups.indexOf(g)) ?? null) : null),
    xfs: groups.map(() => null),
    extents: groups.map(() => null),
    ctx,
    maxTexture: 8192,
    groupAtlas: true,
    ...over
  }
}

const kinds = (steps: GroupStep[]) => steps.map((s) => s.kind)

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

describe('planLevel', () => {
  test('plain groups become leaves sharing one packed texture', () => {
    const list = [push(0), draw, pop(0), push(1), draw, pop(1)]
    const groups = [group(100), group(300)]
    const p = planLevel(main, 0, list.length, input(list, groups))
    assert.deepEqual(p.steps, [])
    assert.equal(p.leaves.length, 2)
    assert.deepEqual(
      p.leaves.map((l) => [l.i, l.j, l.group]),
      [
        [0, 2, 0],
        [3, 5, 1]
      ]
    )
    // Measured with a 1 px margin: 202 × 102 device px.
    assert.deepEqual([p.leaves[0]?.m.w, p.leaves[0]?.m.h], [202, 102])
    assert.ok(p.packed?.at.every((a) => a !== null))
  })

  test('a single leaf is not packed', () => {
    const list = [push(0), draw, pop(0)]
    const p = planLevel(main, 0, 3, input(list, [group(0)]))
    assert.equal(p.leaves.length, 1)
    assert.equal(p.packed, null)
  })

  test('without the group atlas, or with nesting, a group gets its own', () => {
    const list = [push(0), draw, pop(0)]
    const off = planLevel(
      main,
      0,
      3,
      input(list, [group(0)], { groupAtlas: false })
    )
    assert.deepEqual(kinds(off.steps), ['own'])
    const nested = [push(0), push(1), draw, pop(1), pop(0)]
    const p = planLevel(main, 0, 5, input(nested, [group(0), group(10)]))
    assert.deepEqual(kinds(p.steps), ['own'])
    // Its inner group is planned later, inside its own texture.
    assert.deepEqual(p.leaves, [])
  })

  test('backdrops and extra layers inside rule out a leaf', () => {
    for (const inner of [
      { kind: 'backdrop', index: 0 } as DrawBatch,
      { kind: 'extra', id: 1 } as DrawBatch
    ]) {
      const list = [push(0), inner, pop(0)]
      const p = planLevel(main, 0, 3, input(list, [group(0)]))
      assert.deepEqual(kinds(p.steps), ['own'])
    }
  })

  test('blur and drop shadows run on its own texture', () => {
    const shadow = { dx: 2, dy: 2, blur: 4, color: [0, 0, 0, 1] }
    const filter = {
      matrices: [],
      blur: 3,
      shadows: [shadow]
    } as unknown as GroupFilter
    const list = [push(0), draw, pop(0)]
    const p = planLevel(main, 0, 3, input(list, [group(0, { filter })]))
    const s = p.steps[0]
    assert.equal(s?.kind, 'own')
    if (s?.kind === 'own') {
      assert.equal(s.blur, 3)
      assert.equal(s.shadows.length, 1)
      assert.equal(s.label, 'group')
    }
  })

  test('a group outside the band, above or below, is skipped', () => {
    const list = [
      push(0),
      draw,
      pop(0),
      push(1),
      draw,
      pop(1),
      push(2),
      draw,
      pop(2)
    ]
    const groups = [group(100), group(1500), group(700)]
    const banded = {
      ...main,
      scissor: [0, 600, 1000, 300] as [number, number, number, number]
    }
    const p = planLevel(banded, 0, 9, input(list, groups))
    assert.deepEqual(
      p.steps.map((s) => [s.kind, s.i]),
      [
        ['skip', 0],
        ['skip', 3]
      ]
    )
    assert.deepEqual(
      p.leaves.map((l) => l.group),
      [2]
    )
  })

  test('outside the band under a layer transform or a region pass, skipped', () => {
    const list = [push(0), draw, pop(0), push(1), draw, pop(1)]
    const groups = [
      group(100, {
        alpha: 1,
        box: { x: 100, y: 100, width: 200, height: 100 }
      }),
      group(1500, { alpha: 1 })
    ]
    const banded = {
      ...main,
      scissor: [0, 600, 1000, 300] as [number, number, number, number]
    }
    const region: RegionHandler = {
      pad: () => 0,
      active: () => true,
      encode: () => {},
      composite: () => {}
    }
    const effects = new Map<number, GroupEffect>([
      [0, { kind: 'transform', transform: transform({ scaleX: 0.9 }) }],
      [1, { kind: 'region', region }]
    ])
    const xfs = [
      layerAffine(groups[0] as OpacityGroup, transform({ scaleX: 0.9 }), ctx),
      null
    ]
    const p = planLevel(banded, 0, 6, input(list, groups, { xfs }, effects))
    assert.deepEqual(kinds(p.steps), ['skip', 'skip'])
    // Moved into the band by its transform, or reaching it: drawn.
    const down = [
      layerAffine(groups[0] as OpacityGroup, transform({ y: 550 }), ctx),
      null
    ]
    region.pad = () => 700
    const q = planLevel(
      banded,
      0,
      6,
      input(list, groups, { xfs: down }, effects)
    )
    assert.deepEqual(kinds(q.steps), ['own', 'own'])
  })

  test('a blurred or shadowed group reaching into the band is drawn', () => {
    const list = [push(0), draw, pop(0)]
    const banded = {
      ...main,
      scissor: [0, 600, 1000, 300] as [number, number, number, number]
    }
    const shadow = { dx: 0, dy: 60, sigma: 10, color: [0, 0, 0, 1] }
    const filter = {
      matrices: [],
      blur: 0,
      shadows: [shadow]
    } as unknown as GroupFilter
    const near = group(420, { filter })
    assert.deepEqual(
      kinds(planLevel(banded, 0, 3, input(list, [near])).steps),
      ['own']
    )
    const far = group(300, { filter })
    assert.deepEqual(kinds(planLevel(banded, 0, 3, input(list, [far])).steps), [
      'skip'
    ])
  })

  test('an invisible group or one with nothing inside is skipped', () => {
    const list = [push(0), draw, pop(0), push(1), draw, pop(1)]
    const empty = group(0, { bounds: { x: 0, y: 0, width: 0, height: 0 } })
    const p = planLevel(
      main,
      0,
      6,
      input(list, [group(300, { alpha: 0 }), empty], { groupAtlas: false })
    )
    assert.deepEqual(kinds(p.steps), ['skip', 'skip'])
  })

  test('a layer transform at rest draws in place; its groups join the parent', () => {
    const list = [push(0), push(1), draw, pop(1), pop(0)]
    const groups = [group(0, { alpha: 1, region: 7 }), group(10)]
    const effects = new Map<number, GroupEffect>([
      [0, { kind: 'transform', transform: transform() }]
    ])
    const p = planLevel(main, 0, 5, input(list, groups, {}, effects))
    const s = p.steps[0]
    assert.equal(s?.kind, 'in-place')
    if (s?.kind === 'in-place') {
      assert.equal(s.inner.leaves.length, 1)
      assert.equal(s.inner.leaves[0]?.group, 1)
    }
  })

  test('under a transform: its own texture at the transform scale', () => {
    // Mid-page, so the scaled texture isn't clipped to the parent.
    const g = group(400, {
      alpha: 1,
      region: 7,
      bounds: { x: 400, y: 400, width: 200, height: 100 },
      box: { x: 400, y: 400, width: 200, height: 100 }
    })
    const t = transform({ scaleX: 2, scaleY: 2 })
    const xf = layerAffine(g, t, ctx)
    const list = [push(0), draw, pop(0)]
    const effects = new Map<number, GroupEffect>([
      [0, { kind: 'transform', transform: t }]
    ])
    const p = planLevel(main, 0, 3, input(list, [g], { xfs: [xf] }, effects))
    const s = p.steps[0]
    assert.equal(s?.kind, 'own')
    if (s?.kind === 'own') {
      assert.equal(s.label, 'layer')
      assert.deepEqual([s.place.kx, s.place.ky], [2, 2])
      assert.equal(s.place.w, 202 * 2)
      assert.equal(s.place.xf, xf)
    }
  })

  test('under a transform: only the part that lands in the parent', () => {
    const g = group(0, {
      alpha: 1,
      region: 7,
      box: { x: 100, y: 0, width: 200, height: 100 }
    })
    const t = transform({ scaleX: 2, scaleY: 2 })
    const xf = layerAffine(g, t, ctx)
    const list = [push(0), draw, pop(0)]
    const effects = new Map<number, GroupEffect>([
      [0, { kind: 'transform', transform: t }]
    ])
    const p = planLevel(main, 0, 3, input(list, [g], { xfs: [xf] }, effects))
    const s = p.steps[0]
    assert.equal(s?.kind, 'own')
    if (s?.kind === 'own') {
      // x 99..301 with its margin, but only 100.. maps back into the
      // parent's x >= 0: 201 px at scale 2.
      assert.equal(s.place.w, 201 * 2)
    }
  })

  test('a region pass: its own texture, padded by its reach', () => {
    const region = {
      active: () => true,
      pad: () => 10
    } as unknown as RegionHandler
    const list = [push(0), draw, pop(0)]
    const effects = new Map<number, GroupEffect>([
      [0, { kind: 'region', region }]
    ])
    const p = planLevel(
      main,
      0,
      3,
      input(list, [group(0, { region: 3, alpha: 1 })], {}, effects)
    )
    const s = p.steps[0]
    assert.equal(s?.kind, 'own')
    if (s?.kind === 'own') {
      assert.equal(s.label, 'region')
      assert.equal(s.region, region)
      assert.equal(s.place.w, 200 + 2 * 11)
    }
  })
})

describe('packGroups', () => {
  const leaf = (w: number, h: number): Leaf => ({
    i: 0,
    j: 0,
    group: 0,
    m: {
      w,
      h,
      sx: 1,
      sy: 1,
      ox: 0,
      oy: 0,
      px: 0,
      py: 0,
      kx: 1,
      ky: 1,
      xf: null
    }
  })

  test('tallest first, on shelves, a gutter apart', () => {
    const p = packGroups([leaf(100, 20), leaf(100, 50), leaf(100, 30)], 8192)
    // Shelf width: the square root of the area, at least the widest:
    // one per shelf here, the tallest on top.
    assert.deepEqual(p.at, [
      [0, 50 + 30 + 2 * ATLAS_GUTTER],
      [0, 0],
      [0, 50 + ATLAS_GUTTER]
    ])
    // Small ones share a shelf, a gutter apart.
    const q = packGroups(
      [leaf(10, 10), leaf(10, 10), leaf(10, 10), leaf(10, 10)],
      8192
    )
    assert.deepEqual(q.at, [
      [0, 0],
      [10 + ATLAS_GUTTER, 0],
      [0, 10 + ATLAS_GUTTER],
      [10 + ATLAS_GUTTER, 10 + ATLAS_GUTTER]
    ])
  })

  test('what does not fit the device stays out', () => {
    const p = packGroups([leaf(100, 100), leaf(5000, 100)], 1024)
    assert.deepEqual(p.at[0], [0, 0])
    assert.equal(p.at[1], null)
  })
})

test('stepUp: a scale rounded up to an eighth of an octave', () => {
  assert.equal(stepUp(1, 8), 1)
  assert.equal(stepUp(2, 8), 2)
  const k = stepUp(1.03, 8)
  assert.ok(Math.abs(k - 2 ** (1 / 8)) < 1e-9)
  assert.equal(stepUp(1.05, 8), k)
  assert.ok(stepUp(0.95, 8) >= 0.95 && stepUp(0.95, 8) <= 1)
})
