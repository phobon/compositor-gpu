// Draw culling (src/gpu/cull.ts): the Culler's three cached queries, their
// invalidation, and the idle-built y index.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { patch, rebuild } from '../../src/dom/scene_sync'
import type { ElNode } from '../../src/dom/tree'
import { Culler, type CullScheduler, type Runs } from '../../src/gpu/cull'
import { Scene } from '../../src/scene/scene'
import { box, el, rect } from './fixtures'

/** A page of `n` 20 px boxes, one per 25 px row, each in its own
 * element. */
function page(n = 300): { scene: Scene; root: ElNode; cards: ElNode[] } {
  const cards = Array.from({ length: n }, (_, i) =>
    el([box(100 + i, rect(0, i * 25, 400, 20))], [])
  )
  const root = el([], cards)
  const scene = new Scene()
  rebuild(scene, root)
  return { scene, root, cards }
}

/** A scheduler that runs nothing until told to. */
function manual(): CullScheduler & { flush(): void; idles: number } {
  let queue: (() => void)[] = []
  const s = {
    idles: 0,
    after: (_ms: number, f: () => void) => {
      queue.push(f)
    },
    idle: (f: () => void) => {
      s.idles++
      queue.push(f)
    },
    flush() {
      while (queue.length > 0) {
        const q = queue
        queue = []
        for (const f of q) {
          f()
        }
      }
    }
  }
  return s
}

const never: CullScheduler = { after: () => {}, idle: () => {} }

/** The box instances a batch list's runs draw. */
function drawn(scene: Scene, runs: Runs): number[] {
  const out: number[] = []
  scene.batches.forEach((b, i) => {
    if (b.kind !== undefined && b.kind !== 'draw') {
      return
    }
    if (b.layer !== 'boxes') {
      return
    }
    const r = runs[i]
    if (r === null || r === undefined) {
      for (let k = b.first; k < b.first + b.count; k++) {
        out.push(k)
      }
      return
    }
    for (let j = 0; j < r.length; j += 2) {
      for (
        let k = r[j] as number;
        k < (r[j] as number) + (r[j + 1] as number);
        k++
      ) {
        out.push(k)
      }
    }
  })
  return out
}

describe('canvas', () => {
  test('reused while the view stays inside the grown region', () => {
    const { scene } = page()
    const c = new Culler(() => false, never)
    const a = c.canvas(scene, [0, 0, 1000, 900], [500, 450])
    assert.equal(c.canvas(scene, [0, 300, 1000, 1200], [500, 450]), a)
    assert.notEqual(c.canvas(scene, [0, 4000, 1000, 4900], [500, 450]), a)
  })

  test('recomputed for a new batch list', () => {
    const { scene } = page()
    const c = new Culler(() => false, never)
    const a = c.canvas(scene, [0, 0, 1000, 900], [500, 450])
    scene.rebatch()
    assert.notEqual(c.canvas(scene, [0, 0, 1000, 900], [500, 450]), a)
  })

  test('a record moved in place drops every cached query', () => {
    const { scene, root, cards } = page()
    const c = new Culler(() => false, never)
    const view = [0, 0, 1000, 900] as const
    const a = c.canvas(scene, view, [0, 0])
    const r = c.rows(scene, 0, 1000, 100, 200)
    const s = c.strip(scene, 0, 1000, 2000, 2096, [2000, 2900])
    // The box at y 5000 moves into view.
    const old = cards[200] as ElNode
    const fresh = el([box(300, rect(0, 450, 400, 20))], [])
    root.kids[200] = fresh
    fresh.parent = root
    assert.equal(patch(scene, [[old, fresh]], { contexts: true }), true)
    assert.equal(scene.refits, 1)
    const b = c.canvas(scene, view, [0, 0])
    assert.notEqual(b, a)
    assert.ok(drawn(scene, b).includes(200))
    assert.ok(!drawn(scene, a).includes(200))
    assert.notEqual(c.rows(scene, 0, 1000, 100, 200), r)
    assert.notEqual(c.strip(scene, 0, 1000, 2000, 2096, [2000, 2900]), s)
  })
})

describe('rows', () => {
  test('snapped to 128 px tiles, a span reused', () => {
    const { scene } = page()
    const c = new Culler(() => false, never)
    const a = c.rows(scene, 0, 1000, 300, 340)
    // Same tile span (256..384 with the 8 px edge).
    assert.equal(c.rows(scene, 0, 1000, 290, 370), a)
    // One px past it reaches the next tile.
    assert.notEqual(c.rows(scene, 0, 1000, 290, 377), a)
    assert.notEqual(c.rows(scene, 0, 1000, 600, 700), a)
    // A row's box is drawn.
    assert.ok(drawn(scene, a).includes(12))
  })

  test('at most 16 spans kept', () => {
    const { scene } = page()
    const c = new Culler(() => false, never)
    const first = c.rows(scene, 0, 1000, 20, 30)
    for (let i = 1; i <= 16; i++) {
      c.rows(scene, 0, 1000, i * 400 + 20, i * 400 + 30)
    }
    assert.notEqual(c.rows(scene, 0, 1000, 20, 30), first)
  })
})

describe('strip', () => {
  test('later strips from the same interval reuse it', () => {
    const { scene } = page()
    const c = new Culler(() => false, never)
    const a = c.strip(scene, 0, 1000, 2000, 2096, [2000, 2900])
    assert.equal(c.strip(scene, 0, 1000, 2096, 2192, [2096, 2900]), a)
    assert.notEqual(c.strip(scene, 0, 1000, 5000, 5096, null), a)
  })

  test('strips taken upwards, from the end of the interval, reuse it too', () => {
    const { scene } = page()
    const c = new Culler(() => false, never)
    const a = c.strip(scene, 0, 1000, 1904, 2000, [1000, 2000])
    assert.equal(c.strip(scene, 0, 1000, 1808, 1904, [1000, 1904]), a)
  })
})

describe('the y index', () => {
  test('the same runs before and after it is built', () => {
    const { scene } = page()
    const walker = new Culler(() => false, never)
    const s = manual()
    const indexed = new Culler(() => false, s)
    indexed.rows(scene, 0, 1000, 0, 10)
    s.flush()
    // One idle step per layer (boxes, images, cutouts, text, paths).
    assert.equal(s.idles, 1 + 5)
    for (let y = 0; y < 7500; y += 377) {
      assert.deepEqual(
        indexed.rows(scene, 0, 1000, y, y + 211),
        walker.rows(scene, 0, 1000, y, y + 211),
        `rows at ${y}`
      )
    }
  })

  test('only the latest batch list is indexed', () => {
    const { scene } = page()
    const s = manual()
    const c = new Culler(() => false, s)
    for (let i = 0; i < 3; i++) {
      c.canvas(scene, [0, 0, 1000, 900], [0, 0])
      scene.rebatch()
    }
    c.canvas(scene, [0, 0, 1000, 900], [0, 0])
    s.flush()
    // Four `after` callbacks each ask for an idle step; only the latest
    // list's builds its five layers, one more step each.
    assert.equal(s.idles, 4 + 5)
  })
})

test('takeMs reports the time since the last call', () => {
  const { scene } = page()
  const c = new Culler(() => false, never)
  c.canvas(scene, [0, 0, 1000, 900], [0, 0])
  assert.ok(c.takeMs() >= 0)
  assert.equal(c.takeMs(), 0)
})

test('batches of kept materials are drawn whole', () => {
  const { scene } = page()
  for (const b of scene.boxes) {
    b.material = 9
  }
  scene.rebatch({ retag: false })
  const c = new Culler((m) => m === 9, never)
  const runs = c.canvas(scene, [0, 0, 1000, 100], [0, 0])
  assert.equal(drawn(scene, runs).length, 300)
})
