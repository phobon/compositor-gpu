// One frame's view of the effect registries (extra layers, region passes,
// layer transforms, materials): which effect each group gets, whether the
// kept texture's content changed, where layer transforms and region
// passes damage it, and the post chain's scene-reuse key. Built once at
// the top of Renderer.render(), before the uploads clear the dirty flags.

import type { DrawBatch } from '../scene/batches'
import type { OpacityGroup } from '../scene/stacking'
import type { FrameContext } from '../types'
import type { ContentKey, LayerDamage, Rows } from './fill_planner'
import type {
  ExtraLayer,
  LayerTransform,
  MaterialEntry,
  RegionHandler
} from './graph'
import { groupExtent, layerAffine, mapRect } from './layer_geometry'
import { addRows } from './rows'

export interface EffectRegistries {
  readonly extras: ReadonlyMap<number, ExtraLayer>
  readonly regions: ReadonlyMap<number, RegionHandler>
  readonly transforms: ReadonlyMap<number, LayerTransform>
  readonly materials: ReadonlyMap<number, MaterialEntry>
}

/** What `snapshotEffects` reads from the scene. */
export interface SnapshotScene {
  readonly groups: readonly OpacityGroup[]
  readonly batches: readonly DrawBatch[]
  readonly version: number
  readonly backdrops: { readonly length: number }
}

export interface SnapshotInput {
  scene: SnapshotScene
  ctx: FrameContext
  dpr: number
  /** A pass's layer is dirty (its upload runs this frame). */
  dirty: boolean
  /** materialPipelinesSettled(): bumps when a material pipeline finishes
   * compiling (records switch pipelines). */
  settled: number
  /** Rows a re-anchor covered are still to be drawn. */
  pendingRows: boolean
}

/** A group's effect: an active region pass takes precedence over a layer
 * transform with the same id. */
export type GroupEffect =
  | { kind: 'region'; region: RegionHandler }
  | { kind: 'transform'; transform: LayerTransform }
  | null

export interface EffectSnapshot {
  effectOf(g: OpacityGroup | undefined): GroupEffect
  /** Whether the kept texture's content changed (fill_planner.ts). */
  content: ContentKey
  /** Where layer transforms and region passes paint this frame. */
  layers: LayerDamage
  /** Everything the post chain's scene texture depends on beyond the
   * records, or null when something drawing into it changes every frame
   * (Renderer.render's scene reuse). Computed on first call. */
  reuseKey(): string | null
}

/** A number per batch list, so keys can name one. */
const batchIds = new WeakMap<readonly DrawBatch[], number>()
let nextBatchId = 1

function batchId(list: readonly DrawBatch[]): number {
  let id = batchIds.get(list)
  if (id === undefined) {
    id = nextBatchId++
    batchIds.set(list, id)
  }
  return id
}

function transformKey(id: number, t: LayerTransform): string {
  return `${id}:${t.x},${t.y},${t.scaleX},${t.scaleY},${t.rotate},${t.opacity},${t.originX},${t.originY};`
}

export function snapshotEffects(
  reg: EffectRegistries,
  input: SnapshotInput
): EffectSnapshot {
  const { scene, ctx, dpr } = input
  const isolated = scene.groups.filter((g) => g.region !== undefined)
  const effectOf = (g: OpacityGroup | undefined): GroupEffect => {
    if (g?.region === undefined) {
      return null
    }
    const region = reg.regions.get(g.region)
    if (region?.active()) {
      return { kind: 'region', region }
    }
    const transform = reg.transforms.get(g.region)
    return transform ? { kind: 'transform', transform } : null
  }

  // Layer damage: groups under a layer transform or an active region
  // pass, at this frame's values. Their rows are damage unless they nest
  // or sit in viewport space (`fallback`: the content counts as changed).
  let rows: Rows = []
  let layerKey = ''
  let live = false
  let fallback = false
  let regionActive = false
  let transformsKey = ''
  for (const g of isolated) {
    const id = g.region as number
    const region = reg.regions.get(id)
    const t = reg.transforms.get(id)
    const active = region?.active() ?? false
    if (t) {
      transformsKey += transformKey(id, t)
    }
    if (!active && !t) {
      continue
    }
    regionActive ||= active
    if (
      g.space === 'viewport' ||
      g.vbounds !== null ||
      isolated.some((h) => h !== g && h.first <= g.first && g.last <= h.last)
    ) {
      fallback = true
    }
    live ||= active
    const e = groupExtent(g, ctx)
    if (!e) {
      continue
    }
    const pad = (active ? Math.max(0, region?.pad() ?? 0) : 0) + 2
    rows = addRows(rows, e[1] - pad, e[3] + pad)
    if (t) {
      layerKey += transformKey(id, t)
      const m = layerAffine(g, t, ctx)
      if (m) {
        const r = mapRect(m, e[0], e[1], e[2], e[3])
        rows = addRows(rows, r[1] - pad, r[3] + pad)
      }
    }
    if (active) {
      layerKey += `${id}:r;`
    }
  }

  let extrasActive = false
  for (const layer of reg.extras.values()) {
    if (layer.active()) {
      extrasActive = true
      break
    }
  }
  // Active non-builtin materials, and whether one may draw differently
  // this frame.
  let mats = ''
  let matsChanging = false
  for (const [id, m] of reg.materials) {
    if (m.builtin || !m.active()) {
      continue
    }
    if (m.changed?.() ?? true) {
      matsChanging = true
    }
    mats += `${id},`
  }

  const base = `${batchId(scene.batches)}|${scene.version}|${input.settled}|${mats}`
  const content: ContentKey = {
    now:
      input.dirty ||
      scene.backdrops.length > 0 ||
      extrasActive ||
      matsChanging ||
      fallback
        ? null
        : base,
    // An active extra layer's pixels stay in the rows until redrawn
    // without it.
    commit: extrasActive ? null : base
  }

  let reuse: string | null | undefined
  const reuseKey = (): string | null => {
    if (reuse !== undefined) {
      return reuse
    }
    reuse =
      input.pendingRows || extrasActive || regionActive || matsChanging
        ? null
        : [
            ctx.canvasX,
            ctx.canvasY,
            ctx.canvasWidth,
            ctx.canvasHeight,
            ctx.scrollX,
            ctx.scrollY,
            ctx.width,
            ctx.height,
            dpr,
            input.settled,
            mats,
            transformsKey
          ].join('|')
    return reuse
  }

  return {
    effectOf,
    content,
    layers: { rows, key: layerKey, live },
    reuseKey
  }
}
