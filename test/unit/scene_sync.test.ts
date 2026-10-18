// Element tree into the scene (src/dom/scene_sync.ts): a patched scene
// must equal one rebuilt from the edited tree, and edits a patch can't
// carry must leave the scene untouched.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { patch, rebuild } from '../../src/dom/scene_sync'
import type { ElKid, ElNode } from '../../src/dom/tree'
import type { BoxRecord, GlyphRun, Rect } from '../../src/scene/records'
import { Scene } from '../../src/scene/scene'

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height }
}

function box(id: number, r: Rect, over: Partial<BoxRecord> = {}): BoxRecord {
  return {
    kind: 'box',
    id,
    z: 0,
    rect: r,
    xform: [1, 0, 0, 1, r.x, r.y],
    local: { width: r.width, height: r.height },
    radius: [0, 0, 0, 0],
    fill: [1, 1, 1, 1],
    opacity: 1,
    clip: null,
    ...over
  } as unknown as BoxRecord
}

function run(id: number, x: number, y: number, n: number): GlyphRun {
  const glyphs = Array.from({ length: n }, (_, i) => {
    const r = rect(x + i * 10, y, 10, 16)
    return {
      index: i,
      rect: r,
      xform: [1, 0, 0, 1, r.x, r.y],
      local: { width: 10, height: 16 },
      glyphId: 97,
      text: 'a',
      colour: false,
      codePoints: 1,
      fontId: 0,
      fontSize: 16,
      color: [0, 0, 0, 1],
      offset: { x: 0, y: 0 }
    }
  })
  return {
    kind: 'text',
    id,
    z: 0,
    fontId: 0,
    fontFamily: 'Test',
    fontStack: 'Test',
    fontWeight: 400,
    opsz: null,
    italic: false,
    ligatures: false,
    color: [0, 0, 0, 1],
    glyphs,
    opacity: 1,
    clip: null
  } as unknown as GlyphRun
}

function el(
  own: ElNode['own'],
  kids: ElKid[],
  over: Partial<ElNode> = {}
): ElNode {
  const n = {
    kind: 'element',
    el: {} as Element,
    parent: null,
    kids,
    rect: rect(0, 0, 1000, 1000),
    space: 'doc',
    trapsFixed: false,
    own,
    isContext: false,
    realContext: false,
    ctxZ: 0,
    childClip: null,
    alpha: 1,
    fragmented: false,
    float: false,
    lin: null,
    decor: null,
    cb: {},
    ...over
  } as unknown as ElNode
  for (const k of kids) {
    if (k.kind === 'element') {
      k.parent = n
    }
  }
  return n
}

/** An opacity group context. */
function group(alpha: number, own: ElNode['own'], kids: ElKid[]): ElNode {
  return el(own, kids, { isContext: true, realContext: true, alpha })
}

/** What a scene draws: each layer's records (by id, paint index and
 * place) and each group's range and alpha. */
function snapshot(scene: Scene): unknown {
  const rec = (r: { id: number; z: number; rect?: Rect }) => [
    r.id,
    r.z,
    r.rect ? [r.rect.x, r.rect.y, r.rect.width, r.rect.height] : null
  ]
  return {
    boxes: scene.boxes.map(rec),
    images: scene.images.map(rec),
    runs: scene.runs.map((r) => [
      r.id,
      r.z,
      r.glyphs.map((g) => [g.rect.x, g.rect.y])
    ]),
    groups: scene.groups.map((g) => [g.first, g.last, g.alpha]),
    materials: [...scene.boxes, ...scene.runs].map((r) => r.material ?? null)
  }
}

/** Materials by record id, applied by the scene's assign hook (the
 * compositor tags /fx material targets this way). */
function withMaterials(
  scene: Scene,
  of: Map<number, number>,
  calls = { n: 0 }
): void {
  scene.assign = () => {
    calls.n++
    for (const r of [...scene.boxes, ...scene.images, ...scene.runs]) {
      const m = of.get(r.id)
      if (m === undefined) {
        delete r.material
      } else {
        r.material = m
      }
    }
  }
}

/**
 * Rebuild a scene from `before()`, swap `target` for `edit(target)` in its
 * parent (as SceneReader.partialRead does), patch, and return the patched
 * scene's snapshot next to one rebuilt from the edited tree.
 */
function patchVsRebuild(
  before: () => { root: ElNode; target: ElNode },
  edit: (old: ElNode) => ElNode,
  opts: { contexts?: boolean; materials?: Map<number, number> } = {}
): {
  ok: boolean
  patched: unknown
  rebuilt: unknown
  scene: Scene
  /** The batch list before the patch. */
  batches: Scene['batches']
  /** Material tagging passes the patch ran. */
  tags: number
} {
  const materials = opts.materials ?? new Map<number, number>()
  const { root, target } = before()
  const scene = new Scene()
  const calls = { n: 0 }
  withMaterials(scene, materials, calls)
  rebuild(scene, root)
  const batches = scene.batches
  calls.n = 0
  const fresh = edit(target)
  const parent = target.parent
  assert.ok(parent)
  parent.kids[parent.kids.indexOf(target)] = fresh
  fresh.parent = parent
  const ok = patch(scene, [[target, fresh]], {
    contexts: opts.contexts ?? true
  })
  const patched = snapshot(scene)
  const tags = calls.n
  const ref = new Scene()
  withMaterials(ref, materials)
  rebuild(ref, root)
  return { ok, patched, rebuilt: snapshot(ref), scene, batches, tags }
}

/** A page: a background box, three cards (a box and a run each, the
 * second underlined), the third inside an opacity group. */
function page(groupAlpha = 0.5, hold = false) {
  const card = (i: number, kids: ElKid[] = []) =>
    el([box(10 + i, rect(0, i * 200, 400, 150))], kids)
  const underlined = run(21, 10, 210, 4)
  underlined.decorations = [box(31, rect(10, 226, 40, 1))]
  underlined.decorationsOver = [box(32, rect(10, 218, 40, 1))]
  const c0 = card(0, [run(20, 10, 10, 5)])
  const c1 = card(1, [underlined])
  const g = group(groupAlpha, [], [card(2, [run(22, 10, 410, 3)])])
  if (hold) {
    g.holdGroup = true
  }
  const root = el([box(1, rect(0, 0, 1000, 1000))], [c0, c1, g])
  return { root, c0, c1, g }
}

describe('a patch equals a rebuild', () => {
  test('same-length text', () => {
    const r = patchVsRebuild(
      () => {
        const p = page()
        return { root: p.root, target: p.c0 }
      },
      () => el([box(10, rect(0, 0, 400, 150))], [run(20, 10, 10, 5)])
    )
    assert.equal(r.ok, true)
    assert.deepEqual(r.patched, r.rebuilt)
  })

  test('decorations keep their order around the run', () => {
    const r = patchVsRebuild(
      () => {
        const p = page()
        return { root: p.root, target: p.c1 }
      },
      () => {
        const u = run(21, 10, 210, 4)
        u.decorations = [box(31, rect(10, 226, 40, 1))]
        u.decorationsOver = [box(32, rect(10, 218, 40, 1))]
        return el([box(11, rect(0, 200, 400, 150))], [u])
      }
    )
    assert.equal(r.ok, true)
    assert.deepEqual(r.patched, r.rebuilt)
  })

  test('a moved box refits and keeps the batch list', () => {
    const r = patchVsRebuild(
      () => {
        const p = page()
        return { root: p.root, target: p.c0 }
      },
      (old) =>
        el([box(10, rect(20, 0, 400, 150))], [run(20, 10, 10, 5)], {
          rect: old.rect
        })
    )
    assert.equal(r.ok, true)
    assert.deepEqual(r.patched, r.rebuilt)
    assert.equal(r.scene.batches, r.batches)
    assert.equal(r.tags, 1)
    assert.equal(r.scene.refits, 1)
    assert.equal(r.scene.moved.length, 1)
  })

  test('an opacity change updates its group', () => {
    const r = patchVsRebuild(
      () => {
        const p = page(0.5)
        return { root: p.root, target: p.g }
      },
      () =>
        group(
          0.8,
          [],
          [el([box(12, rect(0, 400, 400, 150))], [run(22, 10, 410, 3)])]
        )
    )
    assert.equal(r.ok, true)
    assert.deepEqual(r.patched, r.rebuilt)
    assert.deepEqual((r.patched as { groups: unknown[] }).groups.length, 1)
  })

  test('a held group fading to 1 stays a group', () => {
    const r = patchVsRebuild(
      () => {
        const p = page(0.5)
        return { root: p.root, target: p.g }
      },
      () => {
        const g = group(
          1,
          [],
          [el([box(12, rect(0, 400, 400, 150))], [run(22, 10, 410, 3)])]
        )
        g.holdGroup = true
        return g
      }
    )
    assert.equal(r.ok, true)
    assert.deepEqual(r.patched, r.rebuilt)
  })

  test('a material change rebuilds the batch list', () => {
    const materials = new Map<number, number>()
    const r = patchVsRebuild(
      () => {
        const p = page()
        return { root: p.root, target: p.c0 }
      },
      () => {
        materials.set(20, 7)
        return el([box(10, rect(0, 0, 400, 150))], [run(20, 10, 10, 5)])
      },
      { materials }
    )
    assert.equal(r.ok, true)
    assert.deepEqual(r.patched, r.rebuilt)
    assert.equal(r.scene.runs.find((x) => x.id === 20)?.material, 7)
    assert.notEqual(r.scene.batches, r.batches)
    // Tagged once: the rebatch doesn't tag again.
    assert.equal(r.tags, 1)
    assert.equal(r.scene.refits, 0)
  })
})

describe('edits a patch cannot carry leave the scene untouched', () => {
  const cases: [
    string,
    (p: ReturnType<typeof page>) => [ElNode, ElNode],
    boolean?
  ][] = [
    [
      'a different record count',
      (p) => [
        p.c0,
        el(
          [box(10, rect(0, 0, 400, 150)), box(15, rect(0, 0, 10, 10))],
          [run(20, 10, 10, 5)]
        )
      ]
    ],
    [
      'a different glyph count',
      (p) => [p.c0, el([box(10, rect(0, 0, 400, 150))], [run(20, 10, 10, 6)])]
    ],
    [
      'a filter context',
      (p) => {
        const g = group(
          0.5,
          [],
          [el([box(12, rect(0, 400, 400, 150))], [run(22, 10, 410, 3)])]
        )
        g.filter = { matrices: [], blur: 0 } as unknown as ElNode['filter']
        return [p.g, g]
      }
    ],
    [
      'a group change with contexts off',
      (p) => [
        p.g,
        group(
          0.8,
          [],
          [el([box(12, rect(0, 400, 400, 150))], [run(22, 10, 410, 3)])]
        )
      ],
      false
    ],
    [
      'a record moved inside an opacity group',
      (p) => [
        p.g,
        group(
          0.5,
          [],
          [el([box(12, rect(30, 400, 400, 150))], [run(22, 10, 410, 3)])]
        )
      ]
    ],
    [
      'a clip shape',
      (p) => [
        p.c0,
        el(
          [
            box(10, rect(0, 0, 400, 150), {
              clip: { ...rect(0, 0, 400, 150), shape: {} } as Rect
            })
          ],
          [run(20, 10, 10, 5)]
        )
      ]
    ]
  ]
  test('a region in the subtree', () => {
    // The same region node on both sides: only the region rules it out.
    const region = () =>
      el([box(10, rect(0, 0, 400, 150))], [run(20, 10, 10, 5)], {
        isContext: true,
        region: 1
      })
    const p = page()
    const old = region()
    p.root.kids[0] = old
    old.parent = p.root
    const scene = new Scene()
    rebuild(scene, p.root)
    const before = snapshot(scene)
    assert.equal(patch(scene, [[old, region()]], { contexts: true }), false)
    assert.deepEqual(snapshot(scene), before)
  })

  for (const [name, edit, contexts] of cases) {
    test(name, () => {
      const p = page()
      const scene = new Scene()
      rebuild(scene, p.root)
      const before = snapshot(scene)
      const version = scene.version
      const batches = scene.batches
      const [old, fresh] = edit(p)
      assert.equal(
        patch(scene, [[old, fresh]], { contexts: contexts ?? true }),
        false
      )
      assert.deepEqual(snapshot(scene), before)
      assert.equal(scene.version, version)
      assert.equal(scene.batches, batches)
    })
  }
})
