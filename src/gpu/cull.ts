import type { DrawBatch } from '../scene/batches'
import type { Rect } from '../scene/records'
import type { Scene } from '../scene/scene'
import { padGlyphRect, textShadowPad } from '../scene/stacking'

// Draw culling: which instances of each draw batch can land in a region of
// document space. A batch draws a contiguous instance range in paint order,
// and its records can sit anywhere on the page, so a batch is split into
// the runs of instances that intersect the region; gaps shorter than
// `MERGE_GAP` instances are drawn through, to bound the extra draw calls.
// Viewport-space records (position: fixed) always count as visible.

/** Gaps of fewer instances than this between visible runs are drawn. */
const MERGE_GAP = 64

/** A doc-space region: minX, minY, maxX, maxY. */
export type Region = readonly [number, number, number, number]

/** Per batch: null to draw it whole, or [first, count, first, count, ...]
 * (empty: nothing of it is visible). Non-draw batches are null. */
export type Runs = (number[] | null)[]

function hits(r: Rect, g: Region): boolean {
  return (
    r.x < g[2] && r.x + r.width > g[0] && r.y < g[3] && r.y + r.height > g[1]
  )
}

/** Visibility flags per instance of each layer. */
function visibility(scene: Scene, g: Region): Record<string, Uint8Array> {
  const flag = <T extends { rect: Rect; space?: string }>(
    list: readonly T[],
    rectOf: (r: T) => Rect = (r) => r.rect
  ): Uint8Array => {
    const v = new Uint8Array(list.length)
    for (let i = 0; i < list.length; i++) {
      const r = list[i]
      if (r && (r.space === 'viewport' || hits(rectOf(r), g))) {
        v[i] = 1
      }
    }
    return v
  }
  let glyphs = 0
  for (const run of scene.runs) {
    glyphs += run.glyphs.length
  }
  const text = new Uint8Array(glyphs)
  let k = 0
  for (const run of scene.runs) {
    const pad = textShadowPad(run)
    const fixed = run.space === 'viewport'
    for (const glyph of run.glyphs) {
      if (fixed || hits(padGlyphRect(glyph, pad, glyph.fontSize * 0.25), g)) {
        text[k] = 1
      }
      k++
    }
  }
  return {
    boxes: flag(scene.boxes, (b) => b.batchRect ?? b.rect),
    images: flag(scene.images),
    cutouts: flag(scene.cutouts),
    text
  }
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
  const vis = visibility(scene, region)
  const out: Runs = []
  for (const b of batches) {
    if (b.kind !== undefined && b.kind !== 'draw') {
      out.push(null)
      continue
    }
    const flags = vis[b.layer]
    if (!flags || (b.material !== undefined && keep(b.material))) {
      out.push(null)
      continue
    }
    const runs: number[] = []
    let start = -1
    let lastVisible = -1
    const end = b.first + b.count
    for (let i = b.first; i < end; i++) {
      if (!flags[i]) {
        continue
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
