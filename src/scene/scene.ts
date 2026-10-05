import type { Layer } from '../types'
import { type Anchor, buildBatches, type DrawBatch, unionRect } from './batches'
import type {
  BoxRecord,
  CutoutRecord,
  GlyphRun,
  ImageRecord,
  SceneRecord
} from './records'
import type { OpacityGroup } from './stacking'

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
  /** Opacity groups, sorted by `first` (see stacking.ts). Set by the
   * reader before sort(). */
  groups: OpacityGroup[] = []

  private _batches: DrawBatch[] = []
  /** Cross-layer draw batches for the current paint order; see sort(). */
  get batches(): readonly DrawBatch[] {
    return this._batches
  }

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

  allocId(): number {
    return this.nextId++
  }

  clear(): void {
    this.boxes = []
    this.images = []
    this.runs = []
    this.cutouts = []
    this.groups = []
    this.version++
    this.markAllDirty()
    this.hasDynamic = false
  }

  markDirty(layer: Layer): void {
    this.dirtyLayers.add(layer)
  }
  markAllDirty(): void {
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
  }

  add(record: SceneRecord): void {
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
    }
  }

  /** Paint order: back-to-front by z then insertion order. Rebuilds batches. */
  sort(): void {
    this.assign?.()
    const byZ = (a: { z: number }, b: { z: number }) => a.z - b.z
    this.boxes.sort(byZ)
    this.images.sort(byZ)
    this.runs.sort(byZ)
    this.cutouts.sort(byZ)
    const runRects = this.runs.map((r) =>
      unionRect(r.glyphs.map((g) => g.rect))
    )
    this._batches = buildBatches(
      this.boxes,
      this.images,
      this.runs,
      runRects,
      this.cutouts,
      this.groups,
      this.anchors?.() ?? []
    )
  }

  glyphCount(): number {
    let n = 0
    for (const run of this.runs) {
      n += run.glyphs.length
    }
    return n
  }
}
