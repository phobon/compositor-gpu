import type { DrawBatch } from '../scene/batches'
import type { DropShadow } from '../scene/filter'
import type { OpacityGroup } from '../scene/stacking'
import type { FrameContext } from '../types'
import type { GroupEffect } from './effect_snapshot'
import type { RegionHandler } from './graph'
import {
  type Affine,
  axisScales,
  type Box4,
  groupExtent,
  invert,
  layerAlpha,
  mapRect
} from './layer_geometry'
import { clamp } from './rows'

// What happens to each opacity group drawn into a target, one target at a
// time (Renderer.render plans a target's children once its texture is
// known): drawn in place (a layer transform at rest), skipped (nothing of
// it lands in the band being drawn), a leaf sharing one atlas texture and
// pass with its siblings, or a texture of its own (then blurred, drop-
// shadowed or handed to a region pass). Pure: the renderer acquires the
// textures and encodes.

/** Device px between rects in a group atlas (bilinear sampling at an edge
 * must not reach a neighbour). */
export const ATLAS_GUTTER = 2

/** The target a level's groups are drawn into: what placing them needs. */
export interface PlanParent {
  /** Doc-space origin, CSS px. */
  ox: number
  oy: number
  /** Device px per CSS px. */
  sx: number
  sy: number
  /** Texture size, device px. */
  devW: number
  devH: number
  /** The rows being drawn (canvasFill 'band'), device px. */
  scissor?: [number, number, number, number]
}

/** A group's texture placement before a texture is chosen. */
export interface GroupPlace {
  /** Texture size, device px. */
  w: number
  h: number
  /** Texture device px per CSS px. */
  sx: number
  sy: number
  /** Doc-space origin of the group's region. */
  ox: number
  oy: number
  /** Top-left in the parent's device px. */
  px: number
  py: number
  /** The transform's scale the texture renders at. */
  kx: number
  ky: number
  xf: Affine | null
}

/** A group sharing its level's atlas texture: its push and pop batch
 * indices, Scene.groups index and placement. */
export interface Leaf {
  i: number
  j: number
  group: number
  m: GroupPlace
}

/** One group of a level, in batch order. */
export type GroupStep =
  /** Drawn in its parent's pass; its own groups are planned into the same
   * parent (`inner`). */
  | { kind: 'in-place'; i: number; j: number; inner: LevelPlan }
  | { kind: 'skip'; i: number; j: number }
  | {
      kind: 'own'
      i: number
      j: number
      group: number
      place: GroupPlace
      /** The GPU timer's pass label. */
      label: 'group' | 'layer' | 'region'
      /** Gaussian blur after its records (filter: blur()), CSS px. */
      blur: number
      shadows: readonly DropShadow[]
      region: RegionHandler | null
    }

export interface LevelPlan {
  /** In-place, skipped and own-texture groups, in batch order (leaves
   * are drawn after them). */
  steps: GroupStep[]
  /** Groups that may share one atlas texture and pass. */
  leaves: Leaf[]
  /** Their shelf packing; null with fewer than two (each gets its own). */
  packed: Packing | null
}

export interface Packing {
  w: number
  h: number
  /** Each leaf's top-left in the atlas; null: didn't fit (its own). */
  at: ([number, number] | null)[]
}

export interface PlanInput {
  list: readonly DrawBatch[]
  groups: readonly OpacityGroup[]
  effectOf(g: OpacityGroup | undefined): GroupEffect
  /** Layer transforms by group index (null: none or identity). */
  xfs: readonly (Affine | null)[]
  /** Extents grown by transformed descendants, by group index. */
  extents: readonly (Box4 | null)[]
  ctx: FrameContext
  /** The device's largest texture side. */
  maxTexture: number
  /** Leaves share an atlas (CompositorOptions.groupAtlas). */
  groupAtlas: boolean
}

/** Index of the pop matching the push of `group` at `i`. */
export function popOf(
  list: readonly DrawBatch[],
  i: number,
  group: number
): number {
  for (let j = i + 1; j < list.length; j++) {
    const b = list[j]
    if (b && b.kind === 'pop' && b.group === group) {
      return j
    }
  }
  return list.length
}

/** Nothing in list[from, to) needs a pass of its own (nested groups,
 * backdrops, extra layers). */
function isLeaf(list: readonly DrawBatch[], from: number, to: number): boolean {
  for (let k = from; k < to; k++) {
    const kind = list[k]?.kind
    if (kind === 'push' || kind === 'backdrop' || kind === 'extra') {
      return false
    }
  }
  return true
}

/** Plan the groups of list[start, end) drawn into `parent`. */
export function planLevel(
  parent: PlanParent,
  start: number,
  end: number,
  input: PlanInput
): LevelPlan {
  const { list, groups, ctx } = input
  const steps: GroupStep[] = []
  const leaves: Leaf[] = []
  for (let i = start; i < end; i++) {
    const batch = list[i]
    if (batch?.kind !== 'push') {
      continue
    }
    const j = popOf(list, i, batch.group)
    const g = groups[batch.group]
    const effect = input.effectOf(g)
    const region = effect?.kind === 'region' ? effect.region : undefined
    const pad = region ? Math.max(0, region.pad()) : 0
    const t = effect?.kind === 'transform' ? effect.transform : undefined
    const tAlpha = t ? layerAlpha(t) : 1
    const xf = input.xfs[batch.group] ?? null
    if (t && g && !xf && tAlpha === 1 && g.alpha === 1 && !g.filter) {
      // A layer transform at rest: its records draw in place.
      steps.push({
        kind: 'in-place',
        i,
        j,
        inner: planLevel(parent, i + 1, j, input)
      })
      i = j
      continue
    }
    const extent = (): Box4 | null =>
      g ? (input.extents[batch.group] ?? groupExtent(g, ctx)) : null
    // Outside the band being drawn (canvasFill: 'band'): nothing of it
    // would land.
    const band = parent.scissor
    const e = g && band && !xf && !region ? extent() : null
    if (
      e &&
      band &&
      ((e[3] - parent.oy) * parent.sy < band[1] ||
        (e[1] - parent.oy) * parent.sy > band[1] + band[3])
    ) {
      steps.push({ kind: 'skip', i, j })
      i = j
      continue
    }
    if (
      input.groupAtlas &&
      g &&
      !t &&
      !xf &&
      !region &&
      g.alpha > 0 &&
      !(g.filter && (g.filter.blur > 0 || g.filter.shadows.length > 0)) &&
      isLeaf(list, i + 1, j)
    ) {
      const m = measureGroup(
        g,
        parent,
        ctx,
        0,
        null,
        extent(),
        input.maxTexture
      )
      if (m) {
        leaves.push({ i, j, group: batch.group, m })
      } else {
        steps.push({ kind: 'skip', i, j })
      }
      i = j
      continue
    }
    const place =
      g && g.alpha * tAlpha > 0
        ? measureGroup(g, parent, ctx, pad, xf, extent(), input.maxTexture)
        : null
    if (!g || !place) {
      steps.push({ kind: 'skip', i, j })
      i = j
      continue
    }
    steps.push({
      kind: 'own',
      i,
      j,
      group: batch.group,
      place,
      label: region ? 'region' : t ? 'layer' : 'group',
      blur: region ? 0 : (g.filter?.blur ?? 0),
      shadows: region ? [] : (g.filter?.shadows ?? []),
      region: region ?? null
    })
    i = j
  }
  return {
    steps,
    leaves,
    packed: leaves.length > 1 ? packGroups(leaves, input.maxTexture) : null
  }
}

/** Where `g`'s texture sits in `parent` and at what scale; null when
 * nothing of it can land. `pad`: CSS px around the extent (a region
 * pass's reach); `xf`: its layer transform. */
export function measureGroup(
  g: OpacityGroup,
  parent: PlanParent,
  ctx: FrameContext,
  pad: number,
  xf: Affine | null,
  extent: Box4 | null,
  maxTexture: number
): GroupPlace | null {
  if (!extent) {
    return null
  }
  const [bx0, by0, bx1, by1] = extent
  const p = 1 + pad
  let x0: number
  let y0: number
  let x1: number
  let y1: number
  const inv = xf ? invert(xf) : null
  if (xf && !inv) {
    // Scaled to nothing: nothing to draw.
    return null
  }
  if (inv) {
    // Under a layer transform: render the part of the group that can
    // land on the parent (its rect mapped back), not the part that sits
    // on it untransformed.
    // The parent's rect, cut to the ancestors' clip the result gets.
    let px0 = parent.ox
    let py0 = parent.oy
    let px1 = parent.ox + parent.devW / parent.sx
    let py1 = parent.oy + parent.devH / parent.sy
    const c = g.clip
    if (c) {
      const vx = g.space === 'viewport' ? ctx.scrollX : 0
      const vy = g.space === 'viewport' ? ctx.scrollY : 0
      px0 = Math.max(px0, c.x + vx)
      py0 = Math.max(py0, c.y + vy)
      px1 = Math.min(px1, c.x + vx + c.width)
      py1 = Math.min(py1, c.y + vy + c.height)
      if (px1 <= px0 || py1 <= py0) {
        return null
      }
    }
    const [ix0, iy0, ix1, iy1] = mapRect(inv, px0, py0, px1, py1)
    const max = maxTexture
    x0 = Math.floor((Math.max(bx0 - p, ix0) - parent.ox) * parent.sx)
    y0 = Math.floor((Math.max(by0 - p, iy0) - parent.oy) * parent.sy)
    x1 = Math.min(
      Math.ceil((Math.min(bx1 + p, ix1) - parent.ox) * parent.sx),
      x0 + max
    )
    y1 = Math.min(
      Math.ceil((Math.min(by1 + p, iy1) - parent.oy) * parent.sy),
      y0 + max
    )
  } else {
    x0 = clamp(Math.floor((bx0 - p - parent.ox) * parent.sx), parent.devW)
    y0 = clamp(Math.floor((by0 - p - parent.oy) * parent.sy), parent.devH)
    x1 = clamp(Math.ceil((bx1 + p - parent.ox) * parent.sx), parent.devW)
    y1 = clamp(Math.ceil((by1 + p - parent.oy) * parent.sy), parent.devH)
  }
  if (x1 <= x0 || y1 <= y0) {
    return null
  }
  // Under a transform the texture is rendered at the transform's scale
  // (k device px per parent device px), within the size limit.
  let kx = 1
  let ky = 1
  if (inv && xf) {
    const max = maxTexture
    ;[kx, ky] = axisScales(xf)
    kx = Math.min(kx, max / (x1 - x0))
    ky = Math.min(ky, max / (y1 - y0))
  }
  return {
    w: Math.max(1, Math.ceil((x1 - x0) * kx)),
    h: Math.max(1, Math.ceil((y1 - y0) * ky)),
    sx: parent.sx * kx,
    sy: parent.sy * ky,
    ox: parent.ox + x0 / parent.sx,
    oy: parent.oy + y0 / parent.sy,
    px: x0,
    py: y0,
    kx,
    ky,
    xf: inv ? xf : null
  }
}

/**
 * Shelf-pack `leaves`' textures (tallest first) into one atlas no wider
 * or taller than the device allows, with ATLAS_GUTTER between rects.
 * Returns the used size and each one's top-left (null: didn't fit).
 */
export function packGroups(
  leaves: readonly Leaf[],
  maxTexture: number
): Packing {
  const max = maxTexture
  let area = 0
  let widest = 0
  for (const l of leaves) {
    area += (l.m.w + ATLAS_GUTTER) * (l.m.h + ATLAS_GUTTER)
    widest = Math.max(widest, l.m.w + ATLAS_GUTTER)
  }
  const width = Math.min(max, Math.max(widest, Math.ceil(Math.sqrt(area))))
  const order = leaves.map((_, k) => k)
  order.sort((a, b) => (leaves[b]?.m.h ?? 0) - (leaves[a]?.m.h ?? 0))
  const at: ([number, number] | null)[] = leaves.map(() => null)
  let x = 0
  let y = 0
  let shelf = 0
  let used = 0
  for (const k of order) {
    const m = (leaves[k] as Leaf).m
    if (x + m.w > width) {
      x = 0
      y += shelf + ATLAS_GUTTER
      shelf = 0
    }
    if (m.w > width || y + m.h > max) {
      continue
    }
    at[k] = [x, y]
    x += m.w + ATLAS_GUTTER
    used = Math.max(used, x)
    shelf = Math.max(shelf, m.h)
  }
  return { w: Math.max(1, used), h: Math.max(1, y + shelf), at }
}
