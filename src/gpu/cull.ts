import type { DrawBatch } from '../scene/batches'
import type { GlyphRun, Rect } from '../scene/records'
import type { Scene } from '../scene/scene'
import { padGlyphRect, textShadowPad } from '../scene/stacking'

// Draw culling: which instances of each draw batch can land in a region of
// document space. A batch draws a contiguous instance range in paint order,
// and its records can sit anywhere on the page, so a batch is split into
// the runs of instances that intersect the region; gaps shorter than
// `MERGE_GAP` instances are drawn through, to bound the extra draw calls.
// Viewport-space records (position: fixed) always count as visible.
// Each instance's rect is computed once per set of batches (a re-sort
// makes new ones). A query walks every rect until a y index exists; the
// index is built in idle time after the first query on a set, and then a
// query (the same page, a new region: scrolling) visits only the instances
// in the region's buckets and sorts them back into paint order. A page
// that re-sorts every frame never builds one.

/** Gaps of fewer instances than this between visible runs are drawn. */
const MERGE_GAP = 64

/** Bucket height (CSS px) of the y index, doubled on very tall pages to
 * stay under MAX_BUCKETS. */
const BUCKET = 512
const MAX_BUCKETS = 1 << 14

/** A doc-space region: minX, minY, maxX, maxY. */
export type Region = readonly [number, number, number, number]

/** Per batch: null to draw it whole, or [first, count, first, count, ...]
 * (empty: nothing of it is visible). Non-draw batches are null. */
export type Runs = (number[] | null)[]

/** One layer's y index over its rects. */
interface LayerIndex {
  /** y of bucket 0's top, and the bucket height. */
  top: number
  size: number
  /** Bucket k lists instances items[start[k]] .. items[start[k + 1] - 1]
   * (an instance spanning several buckets is in each). */
  start: Uint32Array
  items: Uint32Array
  /** Instances without finite y bounds (viewport space): tested on every
   * query. */
  loose: Uint32Array
  /** Per instance: the query that last visited it (instances in several
   * buckets are tested once). */
  stamp: Uint32Array
  epoch: number
}

/** One layer's culling rects: per instance minX, minY, maxX, maxY
 * (viewport-space records: infinite, so always visible). */
interface Layer {
  b: Float32Array
  index: LayerIndex | null
}

/** Rects by layer, for one set of batches. */
interface Bounds {
  layers: Record<string, Layer>
  /** How many of Scene.moved are written into the rects. */
  applied: number
}

/** Bounds by the batches they were computed for: batches are rebuilt on
 * every re-sort. */
const boundsCache = new WeakMap<readonly DrawBatch[], Bounds>()

function put(b: Float32Array, i: number, r: Rect, fixed: boolean): void {
  const o = i * 4
  if (fixed) {
    b[o] = b[o + 1] = Number.NEGATIVE_INFINITY
    b[o + 2] = b[o + 3] = Number.POSITIVE_INFINITY
    return
  }
  b[o] = r.x
  b[o + 1] = r.y
  b[o + 2] = r.x + r.width
  b[o + 3] = r.y + r.height
}

function bounds(scene: Scene, batches: readonly DrawBatch[]): Bounds {
  const cached = boundsCache.get(batches)
  if (cached) {
    return cached
  }
  const of = <T extends { rect: Rect; space?: string }>(
    list: readonly T[],
    rectOf: (r: T) => Rect = (r) => r.rect
  ): Layer => {
    const b = new Float32Array(list.length * 4)
    for (let i = 0; i < list.length; i++) {
      const r = list[i]
      if (r) {
        put(b, i, rectOf(r), r.space === 'viewport')
      }
    }
    return { b, index: null }
  }
  let glyphs = 0
  for (const run of scene.runs) {
    glyphs += run.glyphs.length
  }
  const text = new Float32Array(glyphs * 4)
  let k = 0
  for (const run of scene.runs) {
    k = putRun(text, k, run)
  }
  const out: Bounds = {
    applied: scene.moved.length,
    layers: {
      boxes: of(scene.boxes, (b) => b.batchRect ?? b.rect),
      images: of(scene.images),
      cutouts: of(scene.cutouts),
      text: { b: text, index: null }
    }
  }
  boundsCache.set(batches, out)
  return out
}

/** Write `run`'s glyph rects from instance `k`; the next instance. */
function putRun(b: Float32Array, k: number, run: GlyphRun): number {
  const pad = textShadowPad(run)
  const fixed = run.space === 'viewport'
  let i = k
  for (const glyph of run.glyphs) {
    put(b, i, padGlyphRect(glyph, pad, glyph.fontSize * 0.25), fixed)
    i++
  }
  return i
}

/** Index of the record with paint index `z` in z-sorted `list`, or -1. */
function byZ(list: readonly { z: number }[], z: number): number {
  let lo = 0
  let hi = list.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const v = list[mid]?.z ?? Number.NaN
    if (v === z) {
      return mid
    }
    if (v < z) {
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return -1
}

/** The y buckets instance `i` of `b` sits in under `ix` ([-1, -1]: not
 * indexed). */
function bucketsOf(
  b: Float32Array,
  i: number,
  ix: LayerIndex
): [number, number] {
  const y0 = b[i * 4 + 1] as number
  const y1 = b[i * 4 + 3] as number
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) {
    return [-1, -1]
  }
  return [
    Math.floor((Math.min(y0, y1) - ix.top) / ix.size),
    Math.floor((Math.max(y0, y1) - ix.top) / ix.size)
  ]
}

/**
 * Write the bounds of the records Scene.refit kept the batch list for
 * (Scene.moved) into the cached rects of `batches`. A layer's y index is
 * kept when every moved instance stays in its buckets, else dropped (the
 * next query walks; the index is rebuilt in idle time). False when there
 * was nothing new to apply.
 */
export function updateBounds(
  scene: Scene,
  batches: readonly DrawBatch[]
): boolean {
  const all = boundsCache.get(batches)
  if (!all || all.applied >= scene.moved.length) {
    return false
  }
  for (let m = all.applied; m < scene.moved.length; m++) {
    const r = scene.moved[m]
    if (!r) {
      continue
    }
    const name =
      r.kind === 'box'
        ? 'boxes'
        : r.kind === 'image'
          ? 'images'
          : r.kind === 'cutout'
            ? 'cutouts'
            : 'text'
    const layer = all.layers[name]
    if (!layer) {
      continue
    }
    const ix = layer.index
    let first: number
    let count: number
    if (r.kind === 'text') {
      const i = byZ(scene.runs, r.z)
      if (i < 0) {
        continue
      }
      first = 0
      for (let k = 0; k < i; k++) {
        first += scene.runs[k]?.glyphs.length ?? 0
      }
      count = r.glyphs.length
    } else {
      const list: readonly { z: number }[] =
        r.kind === 'box'
          ? scene.boxes
          : r.kind === 'image'
            ? scene.images
            : scene.cutouts
      first = byZ(list, r.z)
      count = 1
      if (first < 0) {
        continue
      }
    }
    const before = ix
      ? Array.from({ length: count }, (_, j) =>
          bucketsOf(layer.b, first + j, ix)
        )
      : null
    if (r.kind === 'text') {
      putRun(layer.b, first, r)
    } else {
      put(
        layer.b,
        first,
        r.kind === 'box' ? (r.batchRect ?? r.rect) : r.rect,
        r.space === 'viewport'
      )
    }
    if (ix && before) {
      for (let j = 0; j < count; j++) {
        const [a0, a1] = before[j] as [number, number]
        const [b0, b1] = bucketsOf(layer.b, first + j, ix)
        if (a0 !== b0 || a1 !== b1) {
          layer.index = null
          break
        }
      }
    }
  }
  all.applied = scene.moved.length
  if (Object.values(all.layers).some((l) => !l.index)) {
    indexWhenIdle(all)
  }
  return true
}

/** Whether instance `i`'s rect in `b` meets `g`. */
function meets(b: Float32Array, i: number, g: Region): boolean {
  const o = i * 4
  return (
    (b[o] as number) < g[2] &&
    (b[o + 2] as number) > g[0] &&
    (b[o + 1] as number) < g[3] &&
    (b[o + 3] as number) > g[1]
  )
}

/** Every instance of `b` that meets `g`, ascending (a walk of all). */
function walk(b: Float32Array, g: Region): Uint32Array {
  const n = b.length / 4
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    if (meets(b, i, g)) {
      out.push(i)
    }
  }
  return Uint32Array.from(out)
}

/** Index `b`'s instances by y (see LayerIndex). */
function buildIndex(b: Float32Array): LayerIndex {
  const n = b.length / 4
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  let loose = 0
  for (let o = 1; o < b.length; o += 4) {
    const y0 = b[o] as number
    const y1 = b[o + 2] as number
    if (Number.isFinite(y0) && Number.isFinite(y1)) {
      lo = Math.min(lo, y0, y1)
      hi = Math.max(hi, y0, y1)
    } else if (!Number.isNaN(y0) && !Number.isNaN(y1)) {
      loose++
    }
  }
  let size = BUCKET
  while ((hi - lo) / size >= MAX_BUCKETS) {
    size *= 2
  }
  const buckets = hi >= lo ? Math.floor((hi - lo) / size) + 1 : 0
  // Each finite instance's first and last bucket (-1: not indexed).
  const k0s = new Int32Array(n).fill(-1)
  const k1s = new Int32Array(n)
  const start = new Uint32Array(buckets + 1)
  const looseList = new Uint32Array(loose)
  let l = 0
  for (let i = 0, o = 1; i < n; i++, o += 4) {
    const y0 = b[o] as number
    const y1 = b[o + 2] as number
    if (Number.isFinite(y0) && Number.isFinite(y1)) {
      const k0 = Math.floor(((y0 < y1 ? y0 : y1) - lo) / size)
      const k1 = Math.floor(((y0 < y1 ? y1 : y0) - lo) / size)
      k0s[i] = k0
      k1s[i] = k1
      for (let k = k0; k <= k1; k++) {
        start[k + 1] = (start[k + 1] as number) + 1
      }
    } else if (!Number.isNaN(y0) && !Number.isNaN(y1)) {
      looseList[l++] = i
    }
  }
  for (let k = 0; k < buckets; k++) {
    start[k + 1] = (start[k + 1] as number) + (start[k] as number)
  }
  const items = new Uint32Array(start[buckets] ?? 0)
  const fill = start.slice(0, buckets)
  for (let i = 0; i < n; i++) {
    const k0 = k0s[i] as number
    if (k0 < 0) {
      continue
    }
    const k1 = k1s[i] as number
    for (let k = k0; k <= k1; k++) {
      const at = fill[k] as number
      items[at] = i
      fill[k] = at + 1
    }
  }
  return {
    top: lo,
    size,
    start,
    items,
    loose: looseList,
    stamp: new Uint32Array(n),
    epoch: 0
  }
}

/** Every instance that meets `g`, ascending, through `ix`. */
function query(b: Float32Array, ix: LayerIndex, g: Region): Uint32Array {
  const { start, items, stamp } = ix
  ix.epoch++
  if (ix.epoch === 0xffffffff) {
    stamp.fill(0)
    ix.epoch = 1
  }
  const epoch = ix.epoch
  const out: number[] = []
  for (const i of ix.loose) {
    if (meets(b, i, g)) {
      out.push(i)
    }
  }
  const k0 = Math.max(0, Math.floor((g[1] - ix.top) / ix.size))
  const k1 = Math.min(start.length - 2, Math.floor((g[3] - ix.top) / ix.size))
  for (let k = k0; k <= k1; k++) {
    const end = start[k + 1] as number
    for (let j = start[k] as number; j < end; j++) {
      const i = items[j] as number
      if (stamp[i] !== epoch) {
        stamp[i] = epoch
        if (meets(b, i, g)) {
          out.push(i)
        }
      }
    }
  }
  return Uint32Array.from(out).sort()
}

/** The bounds waiting for an idle index build (only the latest). */
let pending: Bounds | null = null
const INDEX_AFTER_MS = 250

/** Build `all`'s indexes once it has lasted INDEX_AFTER_MS, when the main
 * thread is next idle, one layer per idle period, unless newer bounds
 * replace it first (a page re-sorting every frame never builds one). */
function indexWhenIdle(all: Bounds): void {
  if (pending === all) {
    return
  }
  pending = all
  const idle =
    typeof requestIdleCallback === 'function'
      ? (f: () => void) => requestIdleCallback(f, { timeout: 1000 })
      : (f: () => void) => setTimeout(f, 50)
  const step = (): void => {
    if (pending !== all) {
      return
    }
    for (const name in all.layers) {
      const layer = all.layers[name] as Layer
      if (!layer.index) {
        layer.index = buildIndex(layer.b)
        idle(step)
        return
      }
    }
    pending = null
  }
  setTimeout(() => idle(step), INDEX_AFTER_MS)
}

/** First position in ascending `v` whose value is at least `x`. */
function lowerBound(v: Uint32Array, x: number): number {
  let lo = 0
  let hi = v.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((v[mid] as number) < x) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  return lo
}

/**
 * The visible runs of every draw batch of `batches` within `region`.
 * Batches whose material `keep` returns true for (vertex hooks may move
 * geometry anywhere) are drawn whole.
 */
export function cullRuns(
  scene: Scene,
  batches: readonly DrawBatch[],
  region: Region,
  keep: (material: number) => boolean
): Runs {
  const all = bounds(scene, batches)
  const vis: Record<string, Uint32Array> = {}
  let walked = false
  for (const name in all.layers) {
    const layer = all.layers[name] as Layer
    if (layer.index) {
      vis[name] = query(layer.b, layer.index, region)
    } else {
      vis[name] = walk(layer.b, region)
      walked = true
    }
  }
  if (walked) {
    indexWhenIdle(all)
  }
  const out: Runs = []
  for (const b of batches) {
    if (b.kind !== undefined && b.kind !== 'draw') {
      out.push(null)
      continue
    }
    const v = vis[b.layer]
    if (!v || (b.material !== undefined && keep(b.material))) {
      out.push(null)
      continue
    }
    const runs: number[] = []
    let start = -1
    let lastVisible = -1
    const end = b.first + b.count
    for (let j = lowerBound(v, b.first); j < v.length; j++) {
      const i = v[j] as number
      if (i >= end) {
        break
      }
      if (start >= 0 && i - lastVisible > MERGE_GAP) {
        runs.push(start, lastVisible + 1 - start)
        start = -1
      }
      if (start < 0) {
        start = i
      }
      lastVisible = i
    }
    if (start >= 0) {
      runs.push(start, lastVisible + 1 - start)
    }
    // Everything visible: draw it whole.
    out.push(runs.length === 2 && runs[1] === b.count ? null : runs)
  }
  return out
}
