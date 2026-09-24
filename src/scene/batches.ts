import type { Layer } from '../types'
import type { BoxRecord, GlyphRun, ImageRecord, Rect } from './records'

/** One draw call: instances [first, first + count) of `layer`, in scene order. */
export interface DrawBatch {
  layer: Layer
  first: number
  count: number
}

/** Bounds-hit on a batch this big is treated as an overlap (conservative). */
const MEMBER_CAP = 256

interface Entry {
  layer: Layer
  z: number
  first: number
  count: number
  rect: Rect
}

interface Accum {
  layer: Layer
  first: number
  count: number
  minX: number
  minY: number
  maxX: number
  maxY: number
  members: Rect[]
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

function accumOverlaps(a: Accum, r: Rect): boolean {
  if (!boundsOverlap(a, r)) return false
  if (a.members.length > MEMBER_CAP) return true
  for (const m of a.members) {
    if (rectsOverlap(m, r)) return true
  }
  return false
}

function newAccum(e: Entry): Accum {
  return {
    layer: e.layer,
    first: e.first,
    count: e.count,
    minX: e.rect.x,
    minY: e.rect.y,
    maxX: e.rect.x + e.rect.width,
    maxY: e.rect.y + e.rect.height,
    members: [e.rect]
  }
}

function extend(a: Accum, e: Entry): void {
  a.count += e.count
  a.minX = Math.min(a.minX, e.rect.x)
  a.minY = Math.min(a.minY, e.rect.y)
  a.maxX = Math.max(a.maxX, e.rect.x + e.rect.width)
  a.maxY = Math.max(a.maxY, e.rect.y + e.rect.height)
  if (a.members.length <= MEMBER_CAP) a.members.push(e.rect)
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
 */
export function buildBatches(
  boxes: BoxRecord[],
  images: ImageRecord[],
  runs: GlyphRun[],
  runRects: Rect[]
): DrawBatch[] {
  const entries: Entry[] = []
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]
    if (!b) continue
    entries.push({ layer: 'boxes', z: b.z, first: i, count: 1, rect: b.rect })
  }
  for (let i = 0; i < images.length; i++) {
    const im = images[i]
    if (!im) continue
    entries.push({
      layer: 'images',
      z: im.z,
      first: i,
      count: 1,
      rect: im.rect
    })
  }
  let glyphBase = 0
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    if (!run) continue
    const count = run.glyphs.length
    entries.push({
      layer: 'text',
      z: run.z,
      first: glyphBase,
      count,
      rect: runRects[i] ?? { x: 0, y: 0, width: 0, height: 0 }
    })
    glyphBase += count
  }
  entries.sort((a, b) => a.z - b.z)

  const batches: Accum[] = []
  const lastIndexForLayer: Partial<Record<Layer, number>> = {}

  for (const e of entries) {
    const tail = batches[batches.length - 1]
    if (tail && tail.layer === e.layer) {
      extend(tail, e)
      continue
    }
    const lastLIdx = lastIndexForLayer[e.layer]
    if (lastLIdx !== undefined) {
      const lastL = batches[lastLIdx]
      if (lastL) {
        let blocked = false
        for (let i = lastLIdx + 1; i < batches.length; i++) {
          const later = batches[i]
          if (later && accumOverlaps(later, e.rect)) {
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

  return batches.map((b) => ({
    layer: b.layer,
    first: b.first,
    count: b.count
  }))
}
