import type { DrawBatch } from '../scene/batches'
import type { SceneRecord } from '../scene/records'
import type { Scene } from '../scene/scene'
import type { OpacityGroup } from '../scene/stacking'
import type { GroupTarget } from './composite'
import type { GroupPlace } from './group_plan'

// Opacity-group textures kept between frames. A group drawn into a
// texture of its own (a filter, a drop shadow, opacity below 1 with
// nested content) is re-rendered every frame the band is drawn, though
// nothing in it changed: on /duo's desktop bento, ~9 blur and 4 group
// passes a scroll frame for screenshots that never change. A group whose
// texture would come out the same reuses last frame's instead.
//
// "The same": its signature, a hash of everything the texture depends
// on, matches the one it was rendered with: where it sits and at what
// scale (GroupPlace), its blur and shadows, the device pixel ratio, and
// for every batch inside it, in order, the identity of each record drawn
// (Scene.replace swaps records rather than mutating them, so a changed
// element is a new record), nested groups' alpha, filter and blend, and
// backdrop records. A group can't be kept when what it draws changes
// without a new record: a dynamic image (video, canvas), a material, an
// extra layer, a nested layer transform or region, viewport-space
// members (they move with the scroll), or while the mirror is
// incomplete (glyphs and images still loading draw as placeholders).
//
// Kept textures are held out of the composite pool (GroupTarget.held)
// until their group stops matching, goes unused for EVICT frames, or the
// total kept area passes MAX_AREA (least recently used first).

/** Frames a kept texture survives unused (a group scrolled out of the
 * band comes back to it). */
const EVICT = 240
/** Device px kept at most, all textures together (~256 MB of RGBA8). */
const MAX_AREA = 64 * 1024 * 1024

interface Entry {
  sig: number
  target: GroupTarget
  used: number
}

/** What else a group's texture depends on (from the renderer). */
export interface CacheContext {
  scene: Scene
  list: readonly DrawBatch[]
  dpr: number
  /** Image records may change without a new record (fades running). */
  imagesVolatile: boolean
  /** Text glyphs move without a new record (onGlyph). */
  textVolatile: boolean
}

export class GroupCache {
  private readonly entries = new Map<object, Entry>()
  private readonly ids = new WeakMap<object, number>()
  private nextId = 1
  private frame = 0
  /** Prefix sums of glyphs per run (text batches index glyphs), for the
   * runs array they were built from. */
  private glyphStarts: number[] = []
  private glyphRuns: unknown = null
  hits = 0
  misses = 0

  constructor(private readonly release: (t: GroupTarget) => void) {}

  begin(): void {
    this.frame++
    this.hits = 0
    this.misses = 0
  }

  private id(o: object): number {
    let i = this.ids.get(o)
    if (i === undefined) {
      i = this.nextId++
      this.ids.set(o, i)
    }
    return i
  }

  /** The signature of the group pushed at `list[i]` (popped at `j`) with
   * placement `m`, or null when it can't be kept. */
  signature(
    c: CacheContext,
    g: OpacityGroup,
    i: number,
    j: number,
    m: GroupPlace,
    blur: number,
    shadows: readonly {
      dx: number
      dy: number
      sigma: number
      color: readonly number[]
    }[]
  ): number | null {
    if (!g.key || g.vbounds || g.space === 'viewport' || m.xf) {
      return null
    }
    let h = 0x811c9dc5
    const mix = (v: number): void => {
      // FNV-1a over the value's 32-bit pieces.
      const x = Number.isInteger(v) ? v : Math.round(v * 4096)
      h = Math.imul(h ^ (x & 0xffff), 0x01000193)
      h = Math.imul(h ^ ((x >>> 16) & 0xffff), 0x01000193)
    }
    mix(m.w)
    mix(m.h)
    mix(m.sx)
    mix(m.sy)
    mix(m.ox)
    mix(m.oy)
    mix(c.dpr)
    mix(blur)
    for (const s of shadows) {
      mix(s.dx)
      mix(s.dy)
      mix(s.sigma)
      for (const v of s.color) {
        mix(v)
      }
    }
    const { scene, list } = c
    for (let k = i + 1; k < j; k++) {
      const b = list[k]
      if (!b) {
        continue
      }
      if (b.kind === 'extra') {
        return null
      }
      if (b.kind === 'push' || b.kind === 'pop') {
        mix(b.kind === 'push' ? 1 : 2)
        const n = scene.groups[b.group]
        if (!n || n.region !== undefined || n.vbounds) {
          return null
        }
        if (b.kind === 'push') {
          mix(n.alpha)
          mix(this.id(cacheKey(n) ?? n))
          for (const ch of n.blend ?? '') {
            mix(ch.charCodeAt(0))
          }
          const f = n.filter
          if (f) {
            mix(f.blur)
            for (const s of f.shadows) {
              mix(s.dx)
              mix(s.dy)
              mix(s.sigma)
            }
            for (const row of f.matrices) {
              for (const v of row) {
                mix(v)
              }
            }
          }
        }
        continue
      }
      if (b.kind === 'backdrop') {
        const r = scene.backdrops[b.index]
        // A viewport-space backdrop's region moves with the scroll.
        if (!r || r.space === 'viewport') {
          return null
        }
        mix(3)
        mix(this.id(r))
        continue
      }
      if (b.material !== undefined) {
        return null
      }
      mix(4)
      if (b.layer === 'text') {
        if (c.textVolatile) {
          return null
        }
        const runs = this.runsFor(scene, b.first, b.count)
        for (const r of runs) {
          mix(this.id(r))
        }
        continue
      }
      const records = layerRecords(scene, b.layer)
      if (!records) {
        return null
      }
      for (let r = b.first; r < b.first + b.count; r++) {
        const rec = records[r]
        if (!rec) {
          return null
        }
        if (rec.kind === 'image' && (rec.dynamic || c.imagesVolatile)) {
          return null
        }
        if (rec.space === 'viewport') {
          return null
        }
        mix(this.id(rec))
      }
    }
    return h >>> 0
  }

  /** The runs holding glyph instances [first, first + count). */
  private runsFor(scene: Scene, first: number, count: number): object[] {
    if (this.glyphRuns !== scene.runs) {
      this.glyphRuns = scene.runs
      this.glyphStarts = []
      let n = 0
      for (const r of scene.runs) {
        this.glyphStarts.push(n)
        n += r.glyphs.length
      }
    }
    const s = this.glyphStarts
    // The last run starting at or before `first`.
    let lo = 0
    let hi = s.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((s[mid] ?? 0) <= first) {
        lo = mid
      } else {
        hi = mid - 1
      }
    }
    const out: object[] = []
    for (let k = lo; k < s.length && (s[k] ?? 0) < first + count; k++) {
      const r = scene.runs[k]
      if (r) {
        out.push(r)
      }
    }
    return out
  }

  /** The kept texture for `key` when its signature still matches. */
  get(key: object, sig: number): GroupTarget | null {
    const e = this.entries.get(key)
    if (!e) {
      this.misses++
      return null
    }
    if (e.sig !== sig) {
      this.drop(key, e)
      this.misses++
      return null
    }
    e.used = this.frame
    this.hits++
    return e.target
  }

  /** Keep `target` (the group's finished texture) for `key`. */
  put(key: object, sig: number, target: GroupTarget): void {
    const old = this.entries.get(key)
    if (old && old.target !== target) {
      this.drop(key, old)
    }
    target.held = true
    this.entries.set(key, { sig, target, used: this.frame })
  }

  /** Let go of entries unused for EVICT frames, then the least recently
   * used while over MAX_AREA. */
  sweep(): void {
    let area = 0
    for (const [k, e] of this.entries) {
      if (this.frame - e.used > EVICT) {
        this.drop(k, e)
      } else {
        area += e.target.width * e.target.height
      }
    }
    if (area <= MAX_AREA) {
      return
    }
    const byAge = [...this.entries].sort((a, b) => a[1].used - b[1].used)
    for (const [k, e] of byAge) {
      if (area <= MAX_AREA || e.used === this.frame) {
        break
      }
      area -= e.target.width * e.target.height
      this.drop(k, e)
    }
  }

  /** Forget everything (the device px ratio, skeleton view, teardown). */
  clear(): void {
    for (const [k, e] of this.entries) {
      this.drop(k, e)
    }
  }

  get size(): number {
    return this.entries.size
  }

  private drop(key: object, e: Entry): void {
    this.entries.delete(key)
    e.target.held = false
    this.release(e.target)
  }
}

/** A group's identity across frames: its element (a re-read gives the
 * group a new reader node, `key`, for the same element), or the node for
 * a positioned pseudo-element's synthetic one (its element is the
 * host's). */
export function cacheKey(g: OpacityGroup): object | undefined {
  const n = g.key as { el?: Element; pseudo?: unknown } | undefined
  if (!n) {
    return undefined
  }
  return n.el && !n.pseudo ? n.el : n
}

function layerRecords(
  scene: Scene,
  layer: string
): readonly SceneRecord[] | null {
  switch (layer) {
    case 'boxes':
      return scene.boxes
    case 'images':
      return scene.images
    case 'cutouts':
      return scene.cutouts
    case 'paths':
      return scene.paths
    default:
      return null
  }
}
