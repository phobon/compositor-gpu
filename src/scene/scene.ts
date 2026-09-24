import type { Layer } from '../types'
import type { BoxRecord, GlyphRun, ImageRecord, SceneRecord } from './records'

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

  /** Layers whose instance buffers need re-upload since they were last drawn. */
  private dirtyLayers = new Set<Layer>(['boxes', 'images', 'text'])
  /** True when any image source is dynamic (drives a continuous render). */
  hasDynamic = false

  private nextId = 1

  allocId(): number {
    return this.nextId++
  }

  clear(): void {
    this.boxes = []
    this.images = []
    this.runs = []
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
        if (record.dynamic) this.hasDynamic = true
        this.markDirty('images')
        break
      case 'text':
        this.runs.push(record)
        this.markDirty('text')
        break
    }
  }

  /** Paint order: back-to-front by z then insertion order. */
  sort(): void {
    const byZ = (a: { z: number }, b: { z: number }) => a.z - b.z
    this.boxes.sort(byZ)
    this.images.sort(byZ)
    this.runs.sort(byZ)
  }

  glyphCount(): number {
    let n = 0
    for (const run of this.runs) n += run.glyphs.length
    return n
  }
}
