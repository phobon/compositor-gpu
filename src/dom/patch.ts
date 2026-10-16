import type { GlyphRun, Rect, SceneRecord } from '../scene/records'
import type { ElNode } from './tree'

// Patching the scene for a partial read (see SceneReader.partialRead): when
// a re-read subtree produces the same records as before (number, kind,
// order, space, clip, per-run glyph and shadow counts, no stacking
// context), the new records can replace the old ones where they sit in the
// scene, keeping their paint indices and instance positions, instead of
// rebuilding the whole scene. Everything else falls back to the rebuild.

/** An old record and the one replacing it. */
export type RecordPair = readonly [SceneRecord, SceneRecord]

/**
 * The records `node`'s subtree adds to the scene, in the order flatten()
 * emits them for a subtree without stacking contexts, and the subtree's
 * stacking contexts in tree order. Null when the subtree holds a region,
 * or a stacking context that isn't plain (opacity, z-index, transform)
 * or when `contexts` is false: a filter, blend group or isolation changes
 * what the group does, not just its alpha.
 *
 * With contexts, the records' paint order is no longer their tree order,
 * but two subtrees with the same contexts (sameContexts) assign paint
 * order the same way, so pairing in tree order still pairs each record
 * with the one taking its place.
 */
export function subtreeRecords(
  node: ElNode,
  contexts = false
): { records: SceneRecord[]; contexts: ElNode[] } | null {
  const out: SceneRecord[] = []
  const ctx: ElNode[] = []
  const visit = (n: ElNode): boolean => {
    if (n.region !== undefined) {
      return false
    }
    if (n.isContext) {
      if (!contexts || n.filter || n.blendGroup || n.isolate) {
        return false
      }
      ctx.push(n)
    }
    for (const r of n.own) {
      out.push(r)
    }
    for (const kid of n.kids) {
      if (kid.kind === 'element') {
        if (!visit(kid)) {
          return false
        }
      } else if (kid.kind === 'box') {
        out.push(kid)
      } else {
        for (const d of kid.decorations ?? []) {
          out.push(d)
        }
        out.push(kid)
        for (const d of kid.decorationsOver ?? []) {
          out.push(d)
        }
      }
    }
    return true
  }
  return visit(node) ? { records: out, contexts: ctx } : null
}

/** Whether a context renders as an opacity group (stacking.ts). */
export function isGroup(n: ElNode): boolean {
  return n.alpha < 1 || n.holdGroup === true
}

/** Same stacking contexts in the same places: the same z-index, own
 * record count and group-ness, pair by pair. Only alphas may differ. */
export function sameContexts(
  a: readonly ElNode[],
  b: readonly ElNode[]
): boolean {
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
export function matchRecords(
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
