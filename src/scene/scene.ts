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

  /** True when instance buffers need re-upload. */
  dirty = true

  private nextId = 1

  allocId(): number {
    return this.nextId++
  }

  clear(): void {
    this.boxes = []
    this.images = []
    this.runs = []
    this.dirty = true
  }

  add(record: SceneRecord): void {
    switch (record.kind) {
      case 'box':
        this.boxes.push(record)
        break
      case 'image':
        this.images.push(record)
        break
      case 'text':
        this.runs.push(record)
        break
    }
    this.dirty = true
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
