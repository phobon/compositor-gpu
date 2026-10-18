import type { GlyphRun, Rect, SceneRecord } from '../scene/records'
import type { Scene } from '../scene/scene'
import {
  assignPaintOrder,
  type OpacityGroup,
  type StackingContext
} from '../scene/stacking'
import type { ElNode } from './tree'

// The element tree (dom/tree.ts) into the scene: a full rebuild, or a
// patch after a partial read. A patch applies when each re-read subtree
// produces the same records as before (number, kind, order, space, clip,
// per-run glyph and shadow counts, the same plain stacking contexts): the
// new records then replace the old ones where they sit in the scene,
// keeping their paint indices and instance positions. Everything else
// falls back to the rebuild. Both read records through walkRecords, the
// one place their paint order within a context is defined.

/** What walkRecords calls, in paint-tree order. */
export interface RecordVisitor {
  /** Each element node, before its records; false stops the walk. */
  enter?(node: ElNode): boolean
  record(r: SceneRecord): void
  /** Each element node, after its subtree. */
  leave?(node: ElNode): void
}

/**
 * Visit `node`'s subtree: an element's own records first, then its kids
 * in order (elements recursed into; a text run as its under-decorations,
 * the run, its line-throughs). False when `enter` stopped it.
 */
export function walkRecords(node: ElNode, v: RecordVisitor): boolean {
  if (v.enter && !v.enter(node)) {
    return false
  }
  for (const r of node.own) {
    v.record(r)
  }
  for (const kid of node.kids) {
    if (kid.kind === 'element') {
      if (!walkRecords(kid, v)) {
        return false
      }
    } else if (kid.kind === 'box') {
      v.record(kid)
    } else {
      for (const d of kid.decorations ?? []) {
        v.record(d)
      }
      v.record(kid)
      for (const d of kid.decorationsOver ?? []) {
        v.record(d)
      }
    }
  }
  v.leave?.(node)
  return true
}

/** `node`'s stacking context (stacking.ts), with no items yet. */
function contextOf(node: ElNode): StackingContext {
  const c: StackingContext = {
    z: node.ctxZ,
    items: [],
    ownCount: node.own.length,
    alpha: node.alpha
  }
  if (node.filter) {
    c.filter = node.filter
  }
  if (node.isolate) {
    c.isolate = true
  }
  if (node.blendGroup) {
    c.blend = node.blendGroup
  }
  if (node.holdGroup) {
    c.hold = true
  }
  c.key = node
  if (node.region !== undefined) {
    c.region = node.region
    c.box = node.rect
    c.clip = node.regionClip ?? null
    c.space = node.space
  }
  return c
}

/**
 * Build the stacking-context tree from an element tree, exactly as a DOM
 * walk would: a context-creating element's own records land first in a new
 * context (see stacking.ts), otherwise in the current one; kids follow in
 * document order. `sink` sees every record once. Returns the opacity
 * groups (see stacking.ts). CPU only.
 */
export function flatten(
  root: ElNode,
  sink?: (record: SceneRecord) => void
): OpacityGroup[] {
  const rootCtx: StackingContext = { z: 0, items: [], ownCount: 0 }
  const stack: StackingContext[] = [rootCtx]
  const top = (): StackingContext => stack[stack.length - 1] ?? rootCtx
  walkRecords(root, {
    enter(node) {
      if (node.isContext) {
        const c = contextOf(node)
        top().items.push(c)
        stack.push(c)
      }
      return true
    },
    record(r) {
      top().items.push(r)
      sink?.(r)
    },
    leave(node) {
      if (node.isContext) {
        stack.pop()
      }
    }
  })
  return assignPaintOrder(rootCtx)
}

/** Rebuild `scene` from the element tree. */
export function rebuild(scene: Scene, tree: ElNode | null): void {
  scene.clear()
  if (tree) {
    scene.groups = flatten(tree, (r) => scene.add(r))
    // Transformed groups composite inside their ancestors' clip shape.
    for (const g of scene.groups) {
      scene.clipIndex(g.clip)
    }
  }
  scene.sort()
}

/** An old record and the one replacing it. */
type RecordPair = readonly [SceneRecord, SceneRecord]

/**
 * The records `node`'s subtree adds to the scene, in walkRecords order,
 * and the subtree's stacking contexts in tree order. Null when the
 * subtree holds a region, or a stacking context that isn't plain
 * (opacity, z-index, transform) or when `contexts` is false: a filter,
 * blend group or isolation changes what the group does, not just its
 * alpha.
 *
 * With contexts, the records' paint order is no longer their tree order,
 * but two subtrees with the same contexts (sameContexts) assign paint
 * order the same way, so pairing in tree order still pairs each record
 * with the one taking its place.
 */
function subtreeRecords(
  node: ElNode,
  contexts: boolean
): { records: SceneRecord[]; contexts: ElNode[] } | null {
  const records: SceneRecord[] = []
  const ctx: ElNode[] = []
  const ok = walkRecords(node, {
    enter(n) {
      if (n.region !== undefined) {
        return false
      }
      if (n.isContext) {
        if (!contexts || n.filter || n.blendGroup || n.isolate) {
          return false
        }
        ctx.push(n)
      }
      return true
    },
    record(r) {
      records.push(r)
    }
  })
  return ok ? { records, contexts: ctx } : null
}

/** Whether a context renders as an opacity group (stacking.ts). */
function isGroup(n: ElNode): boolean {
  return n.alpha < 1 || n.holdGroup === true
}

/** Same stacking contexts in the same places: the same z-index, own
 * record count and group-ness, pair by pair. Only alphas may differ. */
function sameContexts(a: readonly ElNode[], b: readonly ElNode[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      !x ||
      !y ||
      x.ctxZ !== y.ctxZ ||
      x.own.length !== y.own.length ||
      isGroup(x) !== isGroup(y)
    ) {
      return false
    }
  }
  return true
}

function sameRect(a: Rect | undefined, b: Rect | undefined): boolean {
  if (!a || !b) {
    return a === b
  }
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  )
}

/** Same clip, and no exact clip shape on either (shapes are numbered per
 * scene build; a patch can't renumber them). */
function sameClip(
  a: Rect | null | undefined,
  b: Rect | null | undefined
): boolean {
  if (!a || !b) {
    return !a && !b
  }
  return !a.shape && !b.shape && sameRect(a, b)
}

function sameShadows(a: GlyphRun, b: GlyphRun): boolean {
  const sa = a.textShadows ?? []
  const sb = b.textShadows ?? []
  if (sa.length !== sb.length) {
    return false
  }
  for (let i = 0; i < sa.length; i++) {
    const x = sa[i]
    const y = sb[i]
    if (!x || !y || x.ox !== y.ox || x.oy !== y.oy || x.blur !== y.blur) {
      return false
    }
  }
  return true
}

/** Whether `b` occupies the same place as `a` (what batches, culling and
 * group bounds are computed from). */
function sameGeometry(a: SceneRecord, b: SceneRecord): boolean {
  if (a.kind === 'text' && b.kind === 'text') {
    if (!sameShadows(a, b)) {
      return false
    }
    for (let i = 0; i < a.glyphs.length; i++) {
      if (!sameRect(a.glyphs[i]?.rect, b.glyphs[i]?.rect)) {
        return false
      }
    }
    return true
  }
  if (a.kind === 'box' && b.kind === 'box') {
    return sameRect(a.rect, b.rect) && sameRect(a.batchRect, b.batchRect)
  }
  if (a.kind === 'text' || b.kind === 'text') {
    return false
  }
  return sameRect(a.rect, b.rect)
}

/**
 * Pair `before` with `after` record by record. Null when they can't
 * replace each other in place; otherwise the pairs and whether any
 * record's geometry changed.
 */
function matchRecords(
  before: readonly SceneRecord[],
  after: readonly SceneRecord[]
): { pairs: RecordPair[]; moved: boolean } | null {
  if (before.length !== after.length) {
    return null
  }
  const pairs: RecordPair[] = []
  let moved = false
  for (let i = 0; i < before.length; i++) {
    const a = before[i]
    const b = after[i]
    if (
      !a ||
      !b ||
      a.kind !== b.kind ||
      a.kind === 'backdrop' ||
      (a.space ?? 'doc') !== (b.space ?? 'doc') ||
      !sameClip(a.clip, b.clip)
    ) {
      return null
    }
    if (a.kind === 'text' && b.kind === 'text') {
      if (
        a.glyphs.length !== b.glyphs.length ||
        (a.textShadows?.length ?? 0) !== (b.textShadows?.length ?? 0)
      ) {
        return null
      }
    }
    if (
      a.kind === 'image' &&
      b.kind === 'image' &&
      !!a.dynamic !== !!b.dynamic
    ) {
      return null
    }
    if (!moved && !sameGeometry(a, b)) {
      moved = true
    }
    pairs.push([a, b])
  }
  return { pairs, moved }
}

/**
 * Apply re-read subtrees (old node, new node) to `scene` in place: the
 * new records take the old ones' places, the groups of re-read contexts
 * take their new alpha, materials are re-tagged, and batches are rebuilt
 * only if materials changed, or refitted if geometry did. Records that
 * moved inside an opacity group would change its bounds: those need the
 * rebuild. False (scene untouched) when the scene has to be rebuilt
 * instead. `contexts`: subtrees may hold plain stacking contexts
 * (CompositorOptions.patchOpacity).
 */
export function patch(
  scene: Scene,
  swaps: readonly (readonly [ElNode, ElNode])[],
  opts: { contexts: boolean }
): boolean {
  const pairs: RecordPair[] = []
  let moved = false
  const contexts: [ElNode, ElNode][] = []
  for (const [old, fresh] of swaps) {
    const before = subtreeRecords(old, opts.contexts)
    const after = subtreeRecords(fresh, opts.contexts)
    const m =
      before && after && sameContexts(before.contexts, after.contexts)
        ? matchRecords(before.records, after.records)
        : null
    if (!m || !before || !after) {
      return false
    }
    pairs.push(...m.pairs)
    moved ||= m.moved
    before.contexts.forEach((c, i) => {
      const f = after.contexts[i]
      if (f && isGroup(c)) {
        contexts.push([c, f])
      }
    })
  }
  if (
    moved &&
    pairs.some(([r]) =>
      scene.groups.some((g) => g.first <= r.z && r.z < g.last)
    )
  ) {
    return false
  }
  const material = (r: SceneRecord): number | undefined =>
    'material' in r ? r.material : undefined
  const materials = pairs.map(([r]) => material(r))
  if (!scene.replace(pairs)) {
    return false
  }
  // The groups of re-read contexts take the new alpha (and key).
  for (const [old, fresh] of contexts) {
    const g = scene.groups.find((x) => x.key === old)
    if (g) {
      g.alpha = fresh.alpha
      g.key = fresh
    }
  }
  scene.assign?.()
  if (pairs.some(([, r], i) => material(r) !== materials[i])) {
    scene.rebatch({ retag: false })
  } else if (moved) {
    // Keep the batch list if it is still valid for the moved records.
    scene.refit(pairs.filter(([a, b]) => !sameGeometry(a, b)).map(([, b]) => b))
  }
  return true
}
