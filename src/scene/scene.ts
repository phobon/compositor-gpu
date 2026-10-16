import type { Layer } from '../types'
import {
  type Anchor,
  type BatchState,
  buildBatches,
  type DrawBatch,
  emptyBatchState,
  footprints,
  type MovedRecord,
  refitBatches,
  unionRect
} from './batches'
import type {
  BackdropRecord,
  BoxRecord,
  ClipShape,
  CutoutRecord,
  GlyphRun,
  ImageRecord,
  Rect,
  SceneRecord
} from './records'
import type { OpacityGroup } from './stacking'

/** Index of the record with paint index `z` in `list` (sorted by z), or
 * -1. */
function indexByZ(
  list: readonly ({ z: number } | undefined)[],
  z: number
): number {
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

/**
 * Holds the current set of records and tracks which changed since last frame.
 * The Reader rebuilds records; the Renderer consumes them + the dirty set.
 *
 * v1 keeps this deliberately simple (full lists + a dirty flag). Sub-tree
 * diffing and stable-id reconciliation are a follow-up (see ROADMAP §Sync).
 */
export class Scene {
  boxes: BoxRecord[] = []
  images: ImageRecord[] = []
  runs: GlyphRun[] = []
  /** `data-gpu-ignore` holes (see CutoutRecord). */
  cutouts: CutoutRecord[] = []
  /** backdrop-filter elements, by z (drawn through batches of kind
   * 'backdrop', not a layer). */
  backdrops: BackdropRecord[] = []
  /** Opacity groups, sorted by `first` (see stacking.ts). Set by the
   * reader before sort(). */
  groups: OpacityGroup[] = []

  private _batches: DrawBatch[] = []
  /** Cross-layer draw batches for the current paint order; see sort(). */
  get batches(): readonly DrawBatch[] {
    return this._batches
  }
  /** What buildBatches built for `_batches` (refit()). */
  private built: BatchState = emptyBatchState()
  /** Records moved in place since `_batches` was built (refit()), oldest
   * first: the culler updates their bounds (`gpu/cull.ts`). */
  readonly moved: (BoxRecord | ImageRecord | CutoutRecord | GlyphRun)[] = []
  /** Lists kept by refit() instead of rebuilt (stats). */
  refits = 0
  /** Try refit() before rebuilding batches for moved records. */
  refitEnabled = true

  /** Layers whose instance buffers need re-upload since they were last drawn. */
  private dirtyLayers = new Set<Layer>(['boxes', 'images', 'text', 'cutouts'])
  /** True when any image source is dynamic (drives a continuous render). */
  hasDynamic = false

  private nextId = 1
  /** Bumped on every rebuild (clear()): record identity changes. */
  version = 0
  /** Extra-layer positions (gpu/graph.ts `addLayer`), resolved against
   * the current paint order whenever batches are built. */
  anchors: (() => readonly Anchor[]) | null = null
  /** Tags records with material ids (gpu/graph.ts `addMaterial`), run
   * before every batch build. */
  assign: (() => void) | null = null

  /** Exact clip shapes of this build, in first-seen order (index 0 is
   * reserved for "none"; see clipIndex). Rebuilt with the records, so
   * every pass uploads indices from the same table. */
  clipShapes: ClipShape[] = []
  private clipIds = new Map<ClipShape, number>()

  allocId(): number {
    return this.nextId++
  }

  /** The 1-based index of `clip`'s shape in clipShapes (0: none). */
  clipIndex(clip: Rect | null | undefined): number {
    const shape = clip?.shape
    if (!shape) {
      return 0
    }
    let i = this.clipIds.get(shape)
    if (i === undefined) {
      this.clipShapes.push(shape)
      i = this.clipShapes.length
      this.clipIds.set(shape, i)
    }
    return i
  }

  clear(): void {
    this.boxes = []
    this.images = []
    this.runs = []
    this.cutouts = []
    this.backdrops = []
    this.groups = []
    this.clipShapes = []
    this.clipIds.clear()
    this.version++
    this.markAllDirty()
    this.hasDynamic = false
  }

  markDirty(layer: Layer): void {
    this.dirtyLayers.add(layer)
    if (layer === 'text') {
      this.runPatch = null
    }
  }
  markAllDirty(): void {
    this.runPatch = null
    this.dirtyLayers.add('boxes')
    this.dirtyLayers.add('images')
    this.dirtyLayers.add('text')
    this.dirtyLayers.add('cutouts')
  }
  isDirty(layer: Layer): boolean {
    return this.dirtyLayers.has(layer)
  }
  clearDirty(layer: Layer): void {
    this.dirtyLayers.delete(layer)
    if (layer === 'text') {
      this.runPatch = null
    }
  }

  /** While the text layer is dirty only through replace(): the runs
   * replaced (old, new), so the text pass can re-pack just those. */
  private runPatch: [GlyphRun, GlyphRun][] | null = null
  get textPatch(): readonly (readonly [GlyphRun, GlyphRun])[] | null {
    return this.dirtyLayers.has('text') ? this.runPatch : null
  }

  /**
   * Replace records in place (each new record takes its old one's z and
   * index; see dom/patch.ts for when that's valid). Batches are kept:
   * call rebatch() when geometry or materials changed. Records' identity
   * changes, so `version` is bumped. False (nothing changed) when an old
   * record isn't in the scene.
   */
  replace(pairs: readonly (readonly [SceneRecord, SceneRecord])[]): boolean {
    const listOf = (r: SceneRecord): { z: number }[] | null =>
      r.kind === 'box'
        ? this.boxes
        : r.kind === 'image'
          ? this.images
          : r.kind === 'text'
            ? this.runs
            : r.kind === 'cutout'
              ? this.cutouts
              : null
    const at: [({ z: number } | undefined)[], number][] = []
    for (const [a] of pairs) {
      const list = listOf(a)
      const i = list ? indexByZ(list, a.z) : -1
      if (!list || list[i] !== a) {
        return false
      }
      at.push([list, i])
    }
    this.lastBatchesMs = 0
    const runs: [GlyphRun, GlyphRun][] = []
    for (let k = 0; k < pairs.length; k++) {
      const [a, b] = pairs[k] as readonly [SceneRecord, SceneRecord]
      const [list, i] = at[k] as [({ z: number } | undefined)[], number]
      b.z = a.z
      list[i] = b
      if (a.kind === 'text' && b.kind === 'text') {
        runs.push([a, b])
      } else {
        this.markDirty(
          b.kind === 'image'
            ? 'images'
            : b.kind === 'cutout'
              ? 'cutouts'
              : 'boxes'
        )
      }
      if (b.kind === 'image' && b.dynamic) {
        this.hasDynamic = true
      }
    }
    if (runs.length > 0) {
      if (!this.dirtyLayers.has('text')) {
        this.dirtyLayers.add('text')
        this.runPatch = runs
      } else if (this.runPatch) {
        this.runPatch.push(...runs)
      }
    }
    this.version++
    return true
  }

  add(record: SceneRecord): void {
    // Number the shapes in paint-tree order, before any pass uploads.
    this.clipIndex(record.clip)
    switch (record.kind) {
      case 'box':
        this.boxes.push(record)
        this.markDirty('boxes')
        break
      case 'image':
        this.images.push(record)
        if (record.dynamic) {
          this.hasDynamic = true
        }
        this.markDirty('images')
        break
      case 'text':
        this.runs.push(record)
        this.markDirty('text')
        break
      case 'cutout':
        this.cutouts.push(record)
        this.markDirty('cutouts')
        break
      case 'backdrop':
        this.backdrops.push(record)
        break
    }
  }

  /** ms the last sort() spent building batches (profile). */
  lastBatchesMs = 0

  /** Paint order: back-to-front by z then insertion order. Rebuilds batches. */
  sort(): void {
    this.assign?.()
    const byZ = (a: { z: number }, b: { z: number }) => a.z - b.z
    this.boxes.sort(byZ)
    this.images.sort(byZ)
    this.runs.sort(byZ)
    this.cutouts.sort(byZ)
    this.backdrops.sort(byZ)
    this.buildBatchList()
  }

  /** Re-tag materials and rebuild batches over the current order (records
   * replaced in place). */
  rebatch(): void {
    this.assign?.()
    this.buildBatchList()
  }

  /**
   * After replace() with records that moved (same materials): keep the
   * batch list when it is still valid for their new footprints
   * (batches.ts refitBatches), else rebuild it. Kept: the records are
   * queued in `moved` for the culler. True when kept.
   */
  refit(records: readonly SceneRecord[]): boolean {
    const moved: MovedRecord[] = []
    const kept: (BoxRecord | ImageRecord | CutoutRecord | GlyphRun)[] = []
    let ok = this.refitEnabled && this.built.accums.length > 0
    for (const r of records) {
      if (!ok) {
        break
      }
      if (r.kind === 'backdrop') {
        ok = false
        break
      }
      const instance = this.instanceOf(r)
      if (instance < 0) {
        ok = false
        break
      }
      moved.push({
        layer:
          r.kind === 'box'
            ? 'boxes'
            : r.kind === 'image'
              ? 'images'
              : r.kind === 'cutout'
                ? 'cutouts'
                : 'text',
        z: r.z,
        instance,
        rects: footprints(r),
        viewport: r.space === 'viewport'
      })
      kept.push(r)
    }
    if (ok && refitBatches(this.built, moved)) {
      this.moved.push(...kept)
      this.refits++
      return true
    }
    this.rebatch()
    return false
  }

  /** First instance of record `r` in its layer's buffer (glyph index for a
   * run), or -1. */
  private instanceOf(r: SceneRecord): number {
    if (r.kind === 'text') {
      const i = indexByZ(this.runs, r.z)
      if (i < 0) {
        return -1
      }
      let n = 0
      for (let k = 0; k < i; k++) {
        n += this.runs[k]?.glyphs.length ?? 0
      }
      return n
    }
    const list =
      r.kind === 'box'
        ? this.boxes
        : r.kind === 'image'
          ? this.images
          : r.kind === 'cutout'
            ? this.cutouts
            : null
    return list ? indexByZ(list, r.z) : -1
  }

  private buildBatchList(): void {
    const runRects = this.runs.map((r) =>
      unionRect(r.glyphs.map((g) => g.rect))
    )
    const t0 = performance.now()
    this.moved.length = 0
    this._batches = buildBatches(
      this.boxes,
      this.images,
      this.runs,
      runRects,
      this.cutouts,
      this.groups,
      this.anchors?.() ?? [],
      this.backdrops,
      this.built
    )
    this.lastBatchesMs = performance.now() - t0
  }

  glyphCount(): number {
    let n = 0
    for (const run of this.runs) {
      n += run.glyphs.length
    }
    return n
  }
}
