import { copyExternalImage } from '../gpu/upload'
import type { RGBA } from '../scene/records'
import { log } from '../util/log'

/** Transparent border around every cell, in atlas (device) px. */
export const ATLAS_PAD = 1
const SIZES = [1024, 2048, 4096] as const
const MAX_SIZE = 4096
// Default-emoji-presentation code points only. Extended_Pictographic would
// also catch text-presentation symbols the browser draws as glyphs from the
// page's font — ©, ®, ™, ↔, ☑ … — which Slug should draw too.
const COLOR_RE = /\p{Emoji_Presentation}/u
const VS15 = '\ufe0e' // text presentation requested
const VS16 = '\ufe0f' // emoji presentation requested

/** True for graphemes the browser should draw in their native colours. */
export function isColorGrapheme(s: string): boolean {
  if (s.includes(VS16)) {
    return true
  }
  if (s.includes(VS15)) {
    return false
  }
  return COLOR_RE.test(s)
}

/** One rasterised grapheme. Lengths are atlas (device) px. */
export interface AtlasEntry {
  u0: number
  v0: number
  u1: number
  v1: number
  /** Font (not ink) ascent/descent — used for the line-box centring rule. */
  ascentPx: number
  descentPx: number
  /** Cell top (excl. pad) to baseline; >= ascentPx when ink overshoots. */
  cellAscPx: number
  /** Cell left (excl. pad) to the pen origin (ceil of actualBoundingBoxLeft). */
  leftPx: number
  w: number
  h: number
  /** Mono: rasterised white, tinted by the glyph colour in the shader. */
  tint: boolean
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/**
 * Canvas 2D glyph atlas for graphemes Slug can't draw (emoji, missing cmap
 * entries, runs with no registered face). The browser's own text engine
 * rasterises each grapheme once; the GPU copy is refreshed in `flush`.
 *
 * Shelf packing. When full it grows 1024 -> 2048 -> 4096 and then clears and
 * restarts; every resize/clear bumps `epoch`, invalidating all entries, so a
 * caller that saw `epoch` change mid-frame must re-request its entries.
 */
export class GlyphAtlas {
  size: number = SIZES[0]
  /** Bumps whenever entries are invalidated (grow or clear). */
  epoch = 0
  /** Bumps whenever the GPU texture object is re-created. */
  generation = 0
  view: GPUTextureView | null = null

  private sizeIdx = 0
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null
  private ctx: Ctx2D | null = null
  private texture: GPUTexture | null = null
  private entries = new Map<string, AtlasEntry | null>()
  private shelfX = 0
  private shelfY = 0
  private shelfH = 0
  private dirty = false
  private warnedFull = false

  // A web font finishing its load changes what the browser would draw for
  // the same key; drop everything so the next upload re-rasterises.
  private readonly onFontsLoaded = (): void => this.reset()

  constructor() {
    if (typeof document !== 'undefined' && document.fonts) {
      document.fonts.addEventListener('loadingdone', this.onFontsLoaded)
    }
  }

  /**
   * Entry for a grapheme, rasterising it on a miss. `stack` is a CSS
   * font-family list; `sizePx` is the device-px font size (whole px).
   * Null when the grapheme has no ink or can't fit even an empty atlas.
   */
  get(
    grapheme: string,
    stack: string,
    weight: number,
    italic: boolean,
    sizePx: number,
    color: RGBA
  ): AtlasEntry | null {
    const tint = !isColorGrapheme(grapheme)
    const fill = tint ? '#fff' : cssRgb(color)
    const key = `${grapheme}|${stack}|${weight}|${italic ? 1 : 0}|${sizePx}|${
      tint ? '' : fill
    }`
    const hit = this.entries.get(key)
    if (hit !== undefined) {
      return hit
    }
    const font = `${italic ? 'italic ' : ''}${weight} ${sizePx}px ${
      stack || 'sans-serif'
    }`
    const entry = this.rasterise(grapheme, font, fill, tint)
    this.entries.set(key, entry)
    return entry
  }

  /**
   * Blurred `text-shadow` silhouette of a grapheme (or a ligature's joined
   * text), rasterised white so any shadow colour can tint it: Canvas 2D's
   * own shadow (σ = blur / 2, as CSS) of text drawn off-cell. `blurPx` is
   * the device-px blur radius (> 0). The cell is padded by 1.5 × blur, and
   * `leftPx`/`cellAscPx` include that pad, so placement matches `get`.
   */
  getShadow(
    text: string,
    stack: string,
    weight: number,
    italic: boolean,
    sizePx: number,
    blurPx: number
  ): AtlasEntry | null {
    const key = `S|${text}|${stack}|${weight}|${italic ? 1 : 0}|${sizePx}|${blurPx}`
    const hit = this.entries.get(key)
    if (hit !== undefined) {
      return hit
    }
    const font = `${italic ? 'italic ' : ''}${weight} ${sizePx}px ${
      stack || 'sans-serif'
    }`
    const entry = this.rasterise(text, font, '#fff', true, blurPx)
    this.entries.set(key, entry)
    return entry
  }

  private ensureCanvas(): Ctx2D | null {
    if (this.ctx) {
      return this.ctx
    }
    const s = this.size
    this.canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(s, s)
        : Object.assign(document.createElement('canvas'), {
            width: s,
            height: s
          })
    // Read back on upload when the direct canvas import fails (gpu/upload.ts).
    this.ctx = this.canvas.getContext('2d', {
      willReadFrequently: true
    }) as Ctx2D | null
    return this.ctx
  }

  private rasterise(
    grapheme: string,
    font: string,
    fill: string,
    tint: boolean,
    blurPx = 0
  ): AtlasEntry | null {
    const ctx = this.ensureCanvas()
    if (!ctx) {
      return null
    }
    const pad = ATLAS_PAD
    // Room for the shadow's Gaussian tail (3σ) on every side.
    const bp = blurPx > 0 ? Math.ceil(blurPx * 1.5) : 0
    ctx.font = font
    ctx.textBaseline = 'alphabetic'
    const m = ctx.measureText(grapheme)
    const inkL = m.actualBoundingBoxLeft
    const inkR = m.actualBoundingBoxRight
    if (!(inkL + inkR > 0)) {
      return null // whitespace / no ink
    }
    const ascentPx = m.fontBoundingBoxAscent
    const descentPx = m.fontBoundingBoxDescent
    // Whole-px pen origin within the cell keeps texels on the device-px grid.
    const leftPx = Math.max(0, Math.ceil(inkL)) + bp
    const cellAscPx =
      Math.ceil(Math.max(ascentPx, m.actualBoundingBoxAscent)) + bp
    const cellDesc =
      Math.ceil(Math.max(descentPx, m.actualBoundingBoxDescent)) + bp
    const w = leftPx + Math.ceil(Math.max(m.width, inkR, 0)) + bp + 2 * pad
    const h = cellAscPx + cellDesc + 2 * pad

    const spot = this.pack(w, h)
    if (!spot) {
      return null
    }
    ctx.fillStyle = fill
    const x = spot.x + pad + leftPx
    const y = spot.y + pad + cellAscPx
    if (bp > 0) {
      // Only the shadow lands in the cell: the text itself is drawn far to
      // the left and the shadow offset brings it back. Clipped to the cell
      // so the tail never bleeds into a neighbour.
      const far = 10000
      ctx.save()
      ctx.beginPath()
      ctx.rect(spot.x, spot.y, w, h)
      ctx.clip()
      ctx.shadowColor = '#fff'
      ctx.shadowBlur = blurPx
      ctx.shadowOffsetX = far
      ctx.shadowOffsetY = 0
      ctx.fillText(grapheme, x - far, y)
      ctx.restore()
    } else {
      ctx.fillText(grapheme, x, y)
    }
    this.dirty = true
    const S = this.size
    return {
      u0: spot.x / S,
      v0: spot.y / S,
      u1: (spot.x + w) / S,
      v1: (spot.y + h) / S,
      ascentPx,
      descentPx,
      cellAscPx,
      leftPx,
      w,
      h,
      tint
    }
  }

  /** Shelf-pack a w×h cell (1px gap between cells); grows or clears if full. */
  private pack(w: number, h: number): { x: number; y: number } | null {
    const gap = 1
    if (w > MAX_SIZE || h > MAX_SIZE) {
      return null
    }
    for (;;) {
      const S = this.size
      if (w <= S && h <= S) {
        if (this.shelfX + w > S) {
          this.shelfY += this.shelfH + gap
          this.shelfX = 0
          this.shelfH = 0
        }
        if (this.shelfY + h <= S) {
          const spot = { x: this.shelfX, y: this.shelfY }
          this.shelfX += w + gap
          this.shelfH = Math.max(this.shelfH, h)
          return spot
        }
      }
      // Full: grow if we can, else clear and restart at the current size.
      if (this.sizeIdx < SIZES.length - 1) {
        this.sizeIdx++
        this.size = SIZES[this.sizeIdx] ?? this.size
        this.ctx = null
        this.canvas = null
        this.resetPacker()
        if (!this.ensureCanvas()) {
          return null
        }
      } else {
        if (!this.warnedFull) {
          this.warnedFull = true
          log.info(`GlyphAtlas: ${this.size}px atlas full — clearing`)
        }
        this.reset() // an empty max-size atlas always fits (checked above)
      }
    }
  }

  private resetPacker(): void {
    this.entries.clear()
    this.shelfX = 0
    this.shelfY = 0
    this.shelfH = 0
    this.epoch++
    this.dirty = true
  }

  /** Evict every entry and clear the canvas (keeps the current size). */
  reset(): void {
    this.ctx?.clearRect(0, 0, this.size, this.size)
    this.resetPacker()
  }

  /** Copy the canvas to the GPU texture if anything was drawn since. */
  flush(device: GPUDevice): void {
    if (!this.canvas) {
      return
    }
    const S = this.size
    if (!this.texture || this.texture.width !== S) {
      this.texture?.destroy()
      this.texture = device.createTexture({
        label: `glyph-atlas ${S}`,
        size: [S, S],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT
      })
      this.view = this.texture.createView()
      this.generation++
      this.dirty = true
    }
    if (!this.dirty) {
      return
    }
    copyExternalImage(
      device,
      { source: this.canvas },
      { texture: this.texture, premultipliedAlpha: true },
      [S, S]
    )
    this.dirty = false
  }

  /** Release the GPU texture, the canvas and the font-load listener. */
  destroy(): void {
    if (typeof document !== 'undefined' && document.fonts) {
      document.fonts.removeEventListener('loadingdone', this.onFontsLoaded)
    }
    this.texture?.destroy()
    this.texture = null
    this.view = null
    this.ctx = null
    this.canvas = null
    this.entries.clear()
  }
}

function cssRgb(c: RGBA): string {
  const b = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255)
  return `rgb(${b(c.r)}, ${b(c.g)}, ${b(c.b)})`
}
