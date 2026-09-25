import type { Layer } from '../types'
import type { BoxRecord, GlyphRun, ImageRecord, Rect } from './records'
import { type OpacityGroup, padGlyphRect, textShadowPad } from './stacking'

/**
 * One entry of the renderer's command list, walked in order:
 * - draw: instances [first, first + count) of `layer`, in scene order.
 * - push / pop: begin / end opacity group `group` (index into
 *   Scene.groups). Pushes and pops nest properly.
 */
export type DrawBatch =
  | { kind?: 'draw'; layer: Layer; first: number; count: number }
  | { kind: 'push'; group: number }
  | { kind: 'pop'; group: number }

interface GroupEvent {
  z: number
  kind: 'push' | 'pop'
  group: number
  depth: number
}

// Members are indexed in a coarse uniform grid so the overlap test stays
// cheap for batches with thousands of records (a 400-card page puts every
// paragraph in one text batch); a candidate only checks the cells it covers.
const CELL = 128

interface Entry {
  layer: Layer
  z: number
  first: number
  count: number
  /** Bounds of the entry (union of `rects`). */
  rect: Rect
  /** Footprints tested for overlap: per-glyph rects for text runs (a run's
   * union rect spans whole paragraphs and would block everything), else
   * just `rect`. */
  rects: Rect[]
}

interface Accum {
  layer: Layer
  first: number
  count: number
  minX: number
  minY: number
  maxX: number
  maxY: number
  /** Members bucketed by grid cell (key = cx * 65536 + cy). */
  grid: Map<number, Rect[]>
}

function forEachCell(r: Rect, fn: (key: number) => boolean | undefined): void {
  const x0 = Math.floor(r.x / CELL)
  const y0 = Math.floor(r.y / CELL)
  const x1 = Math.floor((r.x + r.width) / CELL)
  const y1 = Math.floor((r.y + r.height) / CELL)
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      if (fn(cx * 65536 + cy)) return
    }
  }
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  )
}

function boundsOverlap(a: Accum, r: Rect): boolean {
  return (
    a.minX < r.x + r.width &&
    r.x < a.maxX &&
    a.minY < r.y + r.height &&
    r.y < a.maxY
  )
}

function accumOverlaps(a: Accum, e: Entry): boolean {
  if (!boundsOverlap(a, e.rect)) return false
  for (const r of e.rects) {
    if (rectOverlapsAccum(a, r)) return true
  }
  return false
}

function rectOverlapsAccum(a: Accum, r: Rect): boolean {
  let hit = false
  forEachCell(r, (key) => {
    const cell = a.grid.get(key)
    if (!cell) return false
    for (const m of cell) {
      if (rectsOverlap(m, r)) {
        hit = true
        return true
      }
    }
    return false
  })
  return hit
}

function insertMember(a: Accum, r: Rect): void {
  forEachCell(r, (key) => {
    const cell = a.grid.get(key)
    if (cell) cell.push(r)
    else a.grid.set(key, [r])
    return false
  })
}

function newAccum(e: Entry): Accum {
  const a: Accum = {
    layer: e.layer,
    first: e.first,
    count: e.count,
    minX: e.rect.x,
    minY: e.rect.y,
    maxX: e.rect.x + e.rect.width,
    maxY: e.rect.y + e.rect.height,
    grid: new Map()
  }
  for (const r of e.rects) insertMember(a, r)
  return a
}

function extend(a: Accum, e: Entry): void {
  a.count += e.count
  a.minX = Math.min(a.minX, e.rect.x)
  a.minY = Math.min(a.minY, e.rect.y)
  a.maxX = Math.max(a.maxX, e.rect.x + e.rect.width)
  a.maxY = Math.max(a.maxY, e.rect.y + e.rect.height)
  for (const r of e.rects) insertMember(a, r)
}

/** Union of doc-space rects; a degenerate zero rect for an empty list. */
export function unionRect(rects: Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.width)
    maxY = Math.max(maxY, r.y + r.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * Merge the three z-sorted layers into cross-layer draw batches, minimising
 * draw calls while keeping paint order correct.
 *
 * `runRects[i]` is the union of `runs[i]`'s glyph rects (compute once via
 * `unionRect` in `Scene.sort()`). Text instance indices are cumulative glyph
 * counts over `runs`, since the text pass has one instance per glyph.
 *
 * Greedy rule per record, in global z order:
 * - same layer as the last-appended batch → append to it.
 * - else, if it can be appended to that layer's most recent batch (`lastL`)
 *   without its rect overlapping any record in the batches painted after
 *   `lastL` → append to `lastL` (paints slightly earlier than its z, but
 *   nothing it would have occluded — or been occluded by — changes).
 * - else → start a new batch.
 *
 * Each opacity group's `first` and `last` are hard cuts: when one is
 * crossed a push/pop marker is emitted and no later record merges into a
 * batch before it. `groups` must be sorted by `first` (Scene.groups).
 */
export function buildBatches(
  boxes: BoxRecord[],
  images: ImageRecord[],
  runs: GlyphRun[],
  runRects: Rect[],
  groups: readonly OpacityGroup[] = []
): DrawBatch[] {
  const entries: Entry[] = []
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]
    if (!b) continue
    entries.push({
      layer: 'boxes',
      z: b.z,
      first: i,
      count: 1,
      rect: b.batchRect ?? b.rect,
      rects: [b.batchRect ?? b.rect]
    })
  }
  for (let i = 0; i < images.length; i++) {
    const im = images[i]
    if (!im) continue
    entries.push({
      layer: 'images',
      z: im.z,
      first: i,
      count: 1,
      rect: im.rect,
      rects: [im.rect]
    })
  }
  let glyphBase = 0
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    if (!run) continue
    const count = run.glyphs.length
    // Text shadows paint outside the glyph line boxes: pad each footprint
    // so a shadowed run can't merge past a record its shadow overlaps.
    const pad = textShadowPad(run)
    const rects = pad
      ? run.glyphs.map((g) => padGlyphRect(g, pad))
      : run.glyphs.map((g) => g.rect)
    entries.push({
      layer: 'text',
      z: run.z,
      first: glyphBase,
      count,
      rect: pad
        ? unionRect(rects)
        : (runRects[i] ?? { x: 0, y: 0, width: 0, height: 0 }),
      rects
    })
    glyphBase += count
  }
  entries.sort((a, b) => a.z - b.z)

  // At equal z: pops before pushes; outer pushes before inner, inner pops
  // before outer.
  const events: GroupEvent[] = []
  for (let g = 0; g < groups.length; g++) {
    const grp = groups[g]
    if (!grp) continue
    events.push({ z: grp.first, kind: 'push', group: g, depth: grp.depth })
    events.push({ z: grp.last, kind: 'pop', group: g, depth: grp.depth })
  }
  events.sort((a, b) => {
    if (a.z !== b.z) return a.z - b.z
    if (a.kind !== b.kind) return a.kind === 'pop' ? -1 : 1
    return a.kind === 'push' ? a.depth - b.depth : b.depth - a.depth
  })

  const batches: (Accum | GroupEvent)[] = []
  let lastIndexForLayer: Partial<Record<Layer, number>> = {}
  let ev = 0
  const emitEventsUpTo = (z: number): void => {
    for (let next = events[ev]; next && next.z <= z; next = events[++ev]) {
      batches.push(next)
      lastIndexForLayer = {}
    }
  }

  for (const e of entries) {
    emitEventsUpTo(e.z)
    const tail = batches[batches.length - 1]
    if (tail && 'layer' in tail && tail.layer === e.layer) {
      extend(tail, e)
      continue
    }
    const lastLIdx = lastIndexForLayer[e.layer]
    if (lastLIdx !== undefined) {
      const lastL = batches[lastLIdx]
      if (lastL && 'layer' in lastL) {
        let blocked = false
        for (let i = lastLIdx + 1; i < batches.length; i++) {
          const later = batches[i]
          if (later && 'layer' in later && accumOverlaps(later, e)) {
            blocked = true
            break
          }
        }
        if (!blocked) {
          extend(lastL, e)
          continue
        }
      }
    }
    batches.push(newAccum(e))
    lastIndexForLayer[e.layer] = batches.length - 1
  }

  emitEventsUpTo(Number.POSITIVE_INFINITY)

  return batches.map(
    (b): DrawBatch =>
      'layer' in b
        ? { layer: b.layer, first: b.first, count: b.count }
        : { kind: b.kind, group: b.group }
  )
}
