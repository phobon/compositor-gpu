// The kept-texture fill planner (canvasFill 'band'): which device rows of
// the main target each frame draws, and which hold valid pixels after it.
// Pure: no GPU objects. The renderer carries out each plan (shifting the
// kept texture, scissors, draws) and keeps the textures themselves.
//
// State it owns: the scroll steps of the last 200 ms (they size the band),
// where the kept texture was last drawn, the rows a re-anchor newly
// covered and not yet drawn (`pending`), the rows drawn since the content
// last changed (`valid`), and what those were drawn from (content key,
// fixed content's scroll, layer-damage key and rows).
//
// docs/rd/experiments: 2026-10-16-skip-unchanged, 2026-10-17-fixed-damage,
// 2026-10-17-layer-damage, 2026-10-15-reanchor-spread.

import { addRows, clamp, hullRows, rowsMissing } from './rows'

export type Rows = [number, number][]
/** A full-width device-px rect (x, y, w, h). */
export type Rect4 = [number, number, number, number]
type RowList = readonly (readonly [number, number])[]

/** Pending rows drawn per frame at least, CSS px (reanchorStrips). */
const STRIP_MIN = 96
/** Band rows closer than this (device px) are drawn as one. */
const MERGE_GAP = 64

/** Whether what's drawn into the kept texture would differ from what it
 * holds (effect_snapshot.ts builds it). */
export interface ContentKey {
  /** This frame's key, or null when something draws differently every
   * frame (a dirty layer, a backdrop, an active extra layer, a changing
   * material, layer damage that can't be bounded). */
  now: string | null
  /** The key to remember once drawn; null when the drawn pixels can't be
   * matched later (an active extra layer leaves them behind). */
  commit: string | null
}

/** Groups under a layer transform or an active region pass. */
export interface LayerDamage {
  /** Doc-y CSS px rows they paint at this frame's values. */
  rows: Rows
  /** Their transform values and active regions. */
  key: string
  /** A region pass is active (it may draw differently every frame). */
  live: boolean
}

export type CanvasFill = 'full' | 'band' | 'band-clear'

export interface FillInput {
  now: number
  scrollY: number
  /** Viewport height, CSS px. */
  height: number
  /** The canvas anchor, doc CSS px. */
  canvasX: number
  canvasY: number
  /** Canvas size, device px. */
  devW: number
  devH: number
  /** Device px per CSS px. */
  sx: number
  sy: number
  canvasFill: CanvasFill
  skipUnchanged: boolean
  reanchorStrips: boolean
  /** The post chain runs this frame. */
  chain: boolean
  /** The scene has a backdrop-filter (it restarts the main pass). */
  backdrop: boolean
  content: ContentKey
  layers: LayerDamage
  /** Viewport-y CSS px rows fixed content paints (read only when
   * needed). */
  fixed: () => RowList
}

export type FillPlan = { kind: 'skip' } | DrawPlan

export interface DrawPlan {
  kind: 'draw'
  /** Draw into the kept texture (canvasFill 'band'); false: draw straight
   * to the target and drop any kept texture. */
  keep: boolean
  /** The kept texture's pixels don't line up with the canvas (new, resized
   * or re-scaled): drawn whole. */
  reset: boolean
  /** Move the kept pixels down this many device rows before drawing
   * (negative: up). */
  shift: number
  /** Rows the shift newly covered. */
  fresh: [number, number] | null
  load: 'clear' | 'load'
  /** Rows to clear before the band (fresh rows left for later strips). */
  cleared: [number, number] | null
  /** The main pass's scissor; null: the whole canvas. */
  band: Rect4 | null
  /** More rows drawn after the band, each under its own scissor. */
  extra: Rect4[]
  /** Pending rows drawn after the band and the extras. */
  strip: Rect4 | null
  /** What the band's draw is culled to: the canvas region (around
   * `bandY`), its own rows, or the pending interval it came from. */
  cull: 'canvas' | 'rows' | 'strip'
  /** The band in doc CSS px, or null when the whole canvas is drawn. */
  bandY: [number, number] | null
  /** The pending interval the strip was taken from. */
  stripFrom: [number, number] | null
  /** Device rows drawn (stats().fillRows). */
  fillRows: number
}

interface KeptAt {
  x: number
  y: number
  sx: number
  sy: number
  w: number
  h: number
}

export class FillPlanner {
  /** [time, |scroll step|] of the frames of the last 200 ms, CSS px. */
  private steps: [number, number][] = []
  private lastScrollY: number | null = null
  /** The largest scroll step of the last 200 ms, CSS px. */
  private step = 0
  /** Where the kept texture was last drawn, or null when there's none. */
  private kept: KeptAt | null = null
  /** Device rows of the kept texture a re-anchor newly covered and not yet
   * drawn: disjoint, in order. */
  private pending: Rows = []
  private from: [number, number] | null = null
  /** Device rows drawn since the content last changed: disjoint, in
   * order. */
  private valid: Rows = []
  private lastKey: string | null = null
  /** Scroll fixed content was last drawn at in the kept texture. */
  private fixedScrollY: number | null = null
  private layerKey = ''
  private layerRows: Rows = []
  /** The last frame that drew presented the post chain. */
  private lastChain = false
  private bandY: [number, number] | null = null

  /** Device rows a re-anchor covered not yet drawn. */
  get pendingRowCount(): number {
    let n = 0
    for (const [a, b] of this.pending) {
      n += b - a
    }
    return n
  }

  /** The largest scroll step of the last 200 ms, CSS px. */
  get lastStep(): number {
    return this.step
  }

  /** This frame's plan. Its state then assumes the plan is carried out:
   * call it only on frames that will draw it (or skip). */
  plan(i: FillInput): FillPlan {
    this.noteScroll(i.now, i.scrollY)
    if (!i.chain && this.skip(i)) {
      return { kind: 'skip' }
    }
    this.lastChain = i.chain
    const changed = this.changed(i)
    if (changed) {
      this.valid = []
    }
    return this.draw(i, changed)
  }

  /** A frame that reran the post chain over last frame's scene texture:
   * nothing drawn, but the scroll counts, and content that changed
   * invalidates the kept rows. */
  reuse(i: FillInput): void {
    this.noteScroll(i.now, i.scrollY)
    this.lastChain = i.chain
    if (this.changed(i)) {
      this.valid = []
    }
  }

  /** Drop the kept texture's state (the renderer released it). */
  release(): void {
    this.pending = []
    this.valid = []
    this.from = null
    this.kept = null
  }

  private noteScroll(now: number, scrollY: number): void {
    const dy =
      this.lastScrollY === null ? 0 : Math.abs(scrollY - this.lastScrollY)
    this.lastScrollY = scrollY
    this.steps.push([now, dy])
    while ((this.steps[0]?.[0] ?? now) < now - 200) {
      this.steps.shift()
    }
    let step = 0
    for (const [, d] of this.steps) {
      step = Math.max(step, d)
    }
    this.step = step
  }

  private changed(i: FillInput): boolean {
    return i.content.now === null || i.content.now !== this.lastKey
  }

  /** The viewport plus twice the recent scroll step (at least 128 CSS px)
   * above and below, in device rows of the canvas. */
  private bandRows(i: FillInput): [number, number] {
    const pad = this.pad()
    return [
      clamp(Math.floor((i.scrollY - pad - i.canvasY) * i.sy), i.devH),
      clamp(Math.ceil((i.scrollY + i.height + pad - i.canvasY) * i.sy), i.devH)
    ]
  }

  private pad(): number {
    return Math.max(128, 2 * this.step)
  }

  private aligned(k: KeptAt, i: FillInput): boolean {
    return (
      k.w === i.devW &&
      k.h === i.devH &&
      k.x === i.canvasX &&
      k.y === i.canvasY &&
      k.sx === i.sx &&
      k.sy === i.sy
    )
  }

  /** skipUnchanged: nothing would be drawn (the canvas didn't move, no
   * rows are pending, the content is unchanged and the band's rows are
   * all valid), so the canvas keeps what it last presented. */
  private skip(i: FillInput): boolean {
    const k = this.kept
    if (
      !i.skipUnchanged ||
      this.lastChain ||
      i.canvasFill !== 'band' ||
      !k ||
      this.pending.length > 0 ||
      !this.aligned(k, i) ||
      this.changed(i)
    ) {
      return false
    }
    const [y0, y1] = this.bandRows(i)
    if (this.fixedScrollY !== i.scrollY && i.fixed().length > 0) {
      // Fixed content moved against the canvas.
      return false
    }
    if (i.layers.live || i.layers.key !== this.layerKey) {
      // A layer transform moved or a region pass is drawing.
      return false
    }
    return rowsMissing(y0, y1, this.valid).length === 0
  }

  /** The band (device px), or undefined for the whole canvas. */
  private fillBand(i: FillInput): Rect4 | undefined {
    this.bandY = null
    if (i.canvasFill === 'full') {
      return undefined
    }
    const [y0, y1] = this.bandRows(i)
    if (y0 === 0 && y1 === i.devH) {
      return undefined
    }
    const pad = this.pad()
    this.bandY = [i.scrollY - pad, i.scrollY + i.height + pad]
    return [0, y0, i.devW, y1 - y0]
  }

  /** Line the kept pixels up with this frame's canvas: 'all' when they
   * can't be (redraw everything), the rows a shift newly covers, or null
   * when they already line up. Sets `shift`. */
  private keepMargins(i: FillInput): {
    stale: 'all' | [number, number] | null
    shift: number
  } {
    const k = this.kept
    this.kept = {
      x: i.canvasX,
      y: i.canvasY,
      sx: i.sx,
      sy: i.sy,
      w: i.devW,
      h: i.devH
    }
    if (k && (k.w !== i.devW || k.h !== i.devH)) {
      // A new texture.
      this.pending = []
      this.from = null
      this.valid = []
      return { stale: 'all', shift: 0 }
    }
    if (!k || k.x !== i.canvasX || k.sx !== i.sx || k.sy !== i.sy) {
      this.valid = []
      return { stale: 'all', shift: 0 }
    }
    if (k.y === i.canvasY) {
      return { stale: null, shift: 0 }
    }
    // Content moves down the texture by `s` rows.
    const h = i.devH
    const s = (k.y - i.canvasY) * i.sy
    const r = Math.round(s)
    if (Math.abs(s - r) > 1e-3 || Math.abs(r) >= h) {
      this.valid = []
      return { stale: 'all', shift: 0 }
    }
    const fresh: [number, number] = r > 0 ? [0, r] : [h + r, h]
    // Rows still pending move with the pixels; overlapping intervals
    // merge, disjoint ones stay apart (the rows between are drawn).
    let pending: Rows = [fresh]
    for (const [a, b] of this.pending) {
      const y0 = clamp(a + r, h)
      const y1 = clamp(b + r, h)
      if (y1 > y0) {
        pending = addRows(pending, y0, y1)
      }
    }
    this.pending = pending
    // Valid rows move with the pixels too.
    const valid: Rows = []
    for (const [a, b] of this.valid) {
      const y0 = clamp(a + r, h)
      const y1 = clamp(b + r, h)
      if (y1 > y0) {
        valid.push([y0, y1])
      }
    }
    this.valid = valid
    return { stale: fresh, shift: r }
  }

  /** The strip of pending rows to draw after `band` (at most `k` rows of
   * the interval nearest the band, from its end next to the band),
   * updating `pending`; undefined when nothing is left. Rows the band
   * covers count as drawn. */
  private nextStrip(band: Rect4, devW: number, k: number): Rect4 | undefined {
    const b0 = band[1]
    const b1 = band[1] + band[3]
    const left: Rows = []
    for (const [p0, p1] of this.pending) {
      if (p1 <= b0 || p0 >= b1) {
        left.push([p0, p1])
        continue
      }
      if (p0 < b0) {
        left.push([p0, b0])
      }
      if (p1 > b1) {
        left.push([b1, p1])
      }
    }
    let best = -1
    let bestD = Number.POSITIVE_INFINITY
    for (let j = 0; j < left.length; j++) {
      const [p0, p1] = left[j] as [number, number]
      const d = p0 >= b1 ? p0 - b1 : b0 - p1
      if (d < bestD) {
        bestD = d
        best = j
      }
    }
    const from = left[best]
    if (!from) {
      this.pending = []
      this.from = null
      return undefined
    }
    const [p0, p1] = from
    this.from = [p0, p1]
    let strip: Rect4
    if (p0 >= b1) {
      const e = Math.min(p1, p0 + k)
      from[0] = e
      strip = [0, p0, devW, e - p0]
    } else {
      const s0 = Math.max(p0, p1 - k)
      from[1] = s0
      strip = [0, s0, devW, p1 - s0]
    }
    this.pending = left.filter(([a, b]) => b > a)
    return strip
  }

  private draw(i: FillInput, changed: boolean): DrawPlan {
    let band = this.fillBand(i)
    let load: DrawPlan['load'] = 'clear'
    let reset = false
    let shift = 0
    let fresh: [number, number] | null = null
    let cleared: [number, number] | null = null
    let strip: Rect4 | undefined
    const keep = i.canvasFill === 'band'
    if (keep) {
      const kept = this.keepMargins(i)
      shift = kept.shift
      reset = kept.stale === 'all'
      fresh = kept.stale === 'all' ? null : kept.stale
      if (reset || !band) {
        band = undefined
        this.bandY = null
        this.pending = []
      } else {
        load = 'load'
        if (fresh && i.reanchorStrips) {
          cleared = fresh
        }
        const pending = this.pending
        if (pending.length > 0 && (i.backdrop || !i.reanchorStrips)) {
          // Rows drawn with the band, not culled to it (a backdrop
          // restarts the pass, so no second draw).
          let y0 = band[1]
          let y1 = band[1] + band[3]
          for (const [a, b] of pending) {
            y0 = Math.min(y0, a)
            y1 = Math.max(y1, b)
          }
          band = [0, y0, i.devW, y1 - y0]
          this.pending = []
          this.bandY = null
        } else if (pending.length > 0) {
          const k = Math.ceil(Math.max(STRIP_MIN, 2 * this.step) * i.sy)
          strip = this.nextStrip(band, i.devW, k)
          if (
            strip &&
            strip[1] <= band[1] + band[3] &&
            strip[1] + strip[3] >= band[1]
          ) {
            // Next to the band: one draw over both, culled to both.
            band = hullRows(band, strip)
            strip = undefined
            if (this.bandY) {
              this.bandY = [
                Math.min(this.bandY[0], band[1] / i.sy + i.canvasY),
                Math.max(this.bandY[1], (band[1] + band[3]) / i.sy + i.canvasY)
              ]
            }
          }
        }
      }
    } else if (this.kept) {
      this.release()
    }
    let cull: DrawPlan['cull'] = 'canvas'
    const extra: Rect4[] = []
    if (keep && i.skipUnchanged && band && !changed && load === 'load') {
      // Band rows drawn since the content last changed hold the same
      // pixels: draw only the rest, plus where fixed content and layer
      // damage were and are.
      let need = rowsMissing(band[1], band[1] + band[3], this.valid)
      const fixed = i.fixed()
      if (fixed.length > 0 && this.fixedScrollY !== i.scrollY) {
        for (const y of [i.scrollY, this.fixedScrollY ?? i.scrollY]) {
          for (const [a, b] of fixed) {
            const y0 = clamp(Math.floor((a + y - i.canvasY) * i.sy), i.devH)
            const y1 = clamp(Math.ceil((b + y - i.canvasY) * i.sy), i.devH)
            if (y1 > y0) {
              need = addRows(need, y0, y1)
            }
          }
        }
      }
      if (i.layers.live || i.layers.key !== this.layerKey) {
        for (const [a, b] of [...i.layers.rows, ...this.layerRows]) {
          const y0 = clamp(Math.floor((a - i.canvasY) * i.sy), i.devH)
          const y1 = clamp(Math.ceil((b - i.canvasY) * i.sy), i.devH)
          if (y1 > y0) {
            need = addRows(need, y0, y1)
          }
        }
      }
      // Rows close together are drawn as one (a draw costs vertex work
      // whatever its scissor).
      const parts: Rows = []
      for (const [a, b] of need) {
        const last = parts[parts.length - 1]
        if (last && a - last[1] < MERGE_GAP) {
          last[1] = b
        } else {
          parts.push([a, b])
        }
      }
      const p0 = parts[0]
      if (p0) {
        cull = 'rows'
        band = [0, p0[0], i.devW, p0[1] - p0[0]]
        for (const [a, b] of parts.slice(1)) {
          extra.push([0, a, i.devW, b - a])
        }
      } else if (strip) {
        cull = 'strip'
        band = strip
        strip = undefined
      } else {
        band = [0, 0, i.devW, 0]
      }
    }
    if (keep) {
      // What this frame draws becomes valid.
      if (!band) {
        this.valid = [[0, i.devH]]
      } else {
        for (const r of [band, ...extra, ...(strip ? [strip] : [])]) {
          this.valid = addRows(this.valid, r[1], r[1] + r[3])
        }
      }
      this.lastKey = i.content.commit
      // Fixed content is drawn at this scroll wherever it lands.
      this.fixedScrollY = i.scrollY
      this.layerKey = i.layers.key
      this.layerRows = i.layers.rows
    }
    const fillRows =
      (band ? band[3] : i.devH) +
      (strip ? strip[3] : 0) +
      extra.reduce((n, r) => n + r[3], 0)
    return {
      kind: 'draw',
      keep,
      reset,
      shift,
      fresh,
      load,
      cleared,
      band: band ?? null,
      extra,
      strip: strip ?? null,
      cull,
      bandY: this.bandY,
      stripFrom: this.from,
      fillRows
    }
  }

  /** For tests and traces: the rows state. */
  state(): {
    valid: Rows
    pending: Rows
    fixedScrollY: number | null
    layerKey: string
  } {
    return {
      valid: this.valid.map((r) => [r[0], r[1]]),
      pending: this.pending.map((r) => [r[0], r[1]]),
      fixedScrollY: this.fixedScrollY,
      layerKey: this.layerKey
    }
  }
}
