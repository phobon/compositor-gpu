import { MipGenerator, mipLevelCountFor } from '../gpu/mips'
import { copyExternalImage } from '../gpu/upload'
import { log } from '../util/log'

/** Transparent border kept around every entry, in atlas px (mip bleeding). */
export const GUTTER = 4
/** Entries start on multiples of this (atlas px), so mip levels up to
 * log2(ALIGN) average the same source pixels wherever an entry lands: an
 * unaligned entry's lower mips straddle its pixel grid and blur, and how
 * much depended on what else was packed before it. */
const ALIGN = 16
const START_SIZE = 2048
const HARD_MAX = 4096
/** Images bigger than this (in either dimension) never enter the atlas. */
export const MAX_ENTRY_SIZE = 1024

export interface AtlasRect {
  x: number
  y: number
  w: number
  h: number
}

/** A source `add()` can pack: a live `<img>` (revalidated on grow) or an
 * already-rasterised canvas (e.g. an SVG rasterised at display size — always
 * treated as live, since its pixels only change when the caller mints a new
 * canvas under a new key). */
export type AtlasSource = HTMLImageElement | HTMLCanvasElement | OffscreenCanvas
/** A source `add()` can copy pixels from — an `AtlasSource`, or an
 * `ImageBitmap` decoded off an `HTMLImageElement` to sidestep density
 * correction (see `ImagePass`'s bitmap cache). */
export type AtlasCopySource = AtlasSource | ImageBitmap

interface Entry {
  rect: AtlasRect
  /** The `use` epoch it was last looked up or added in. */
  used: number
}

/** Stable key for a static image source: URL + natural size. */
function key(source: HTMLImageElement, w: number, h: number): string {
  const s = source.currentSrc || source.src
  return `${s}|${w}x${h}`
}

/**
 * One shared `rgba8unorm` texture that packs many small, static
 * (`HTMLImageElement`) sources so an image batch can draw them with a
 * single bind group. Shelf packing, GPU-side (there is no canvas backing
 * this atlas — entries are copied straight from the source element via
 * `copyExternalImageToTexture`, so unlike `GlyphAtlas` there is no 2D
 * context to redraw from on grow/resize).
 *
 * Gutters are left transparent rather than filled from the image's edge
 * pixels — the fragment shader clamps its UV a half-texel inside the entry
 * instead, which is simpler and adequate; mip level >= 2 of a very small
 * entry can show a faint edge darkening as it blends toward that
 * transparent border.
 *
 * Eviction: each `get`/`add` marks its entry with the current epoch
 * (`beginUse`, once per upload of the image records). When an entry
 * doesn't fit at the largest size, the entries used in neither of the
 * last two rounds are dropped and the rest are repacked (`compact`, a copy
 * between textures; their rects change and `generation` bumps). Only
 * when that still leaves no room does `add` refuse (logged once) and the
 * caller falls back to a standalone texture.
 */
export class ImageAtlas {
  size = START_SIZE
  /** Bumps when the GPU texture object is re-created (grow), so a pass
   * rebuilding a bind group on this can detect it cheaply. */
  generation = 0
  view: GPUTextureView | null = null

  private texture: GPUTexture | null = null
  private entries = new Map<string, Entry>()
  private shelfX = 0
  private shelfY = 0
  private shelfH = 0
  private mipsDirty = false
  private warnedFull = false
  private epoch = 0
  /** Packed tallest-first by `compact` since the last entry was added:
   * repacking again without dropping anything can't make room. */
  private packedClean = false
  private readonly mips: MipGenerator

  constructor(private readonly device: GPUDevice) {
    this.mips = new MipGenerator(device)
  }

  get count(): number {
    return this.entries.size
  }

  /** True once the atlas is at max size and has refused an entry. */
  get full(): boolean {
    return this.warnedFull
  }

  private maxSize(): number {
    return Math.min(this.device.limits.maxTextureDimension2D, HARD_MAX)
  }

  private ensureTexture(): GPUTexture {
    if (this.texture) {
      return this.texture
    }
    this.texture = this.createTexture(this.size)
    this.view = this.texture.createView()
    return this.texture
  }

  /** Start a round of lookups: entries not looked up or added from here
   * on are the ones `compact` may drop. */
  beginUse(): void {
    this.epoch++
  }

  private createTexture(size: number): GPUTexture {
    return this.device.createTexture({
      label: `image-atlas ${size}`,
      size: [size, size],
      format: 'rgba8unorm',
      mipLevelCount: mipLevelCountFor(size),
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.RENDER_ATTACHMENT
    })
  }

  /** Copy each of `moves` (old rect -> new origin) from the current
   * texture into `into`, mip 0; the caller regenerates the chain. */
  private copyInto(
    into: GPUTexture,
    moves: [AtlasRect, number, number][]
  ): void {
    const from = this.texture
    if (!from || moves.length === 0) {
      return
    }
    const encoder = this.device.createCommandEncoder({ label: 'image-atlas' })
    for (const [r, x, y] of moves) {
      encoder.copyTextureToTexture(
        { texture: from, origin: [r.x, r.y] },
        { texture: into, origin: [x, y] },
        [r.w, r.h]
      )
    }
    this.device.queue.submit([encoder.finish()])
  }

  /** Shelf-pack a `w`x`h` cell (plus its gutter, at an ALIGN-aligned
   * origin). Null if it can't fit at the current size. */
  private pack(w: number, h: number): { x: number; y: number } | null {
    const s = this.size
    const up = (v: number) => Math.ceil(v / ALIGN) * ALIGN
    if (up(GUTTER) + w + GUTTER > s || up(GUTTER) + h + GUTTER > s) {
      return null
    }
    let x = up(this.shelfX + GUTTER)
    if (x + w + GUTTER > s) {
      this.shelfY += this.shelfH
      this.shelfX = 0
      this.shelfH = 0
      x = up(GUTTER)
    }
    const y = up(this.shelfY + GUTTER)
    if (y + h + GUTTER > s) {
      return null
    }
    this.shelfX = x + w + GUTTER
    this.shelfH = Math.max(this.shelfH, y + h + GUTTER - this.shelfY)
    return { x, y }
  }

  /** Re-create the texture one step bigger (2048 -> 4096, capped at
   * `device.limits.maxTextureDimension2D`) and copy the old one into its
   * top-left: rects and packing state are unchanged. False if already at
   * the cap. */
  private grow(): boolean {
    const max = this.maxSize()
    if (this.size >= max) {
      return false
    }
    const old = this.size
    const newSize = Math.min(old * 2, max)
    const texture = this.createTexture(newSize)
    this.copyInto(texture, [[{ x: 0, y: 0, w: old, h: old }, 0, 0]])
    this.replace(texture, newSize)
    return true
  }

  /** Drop the entries not used in this or the last `beginUse` round and
   * repack the rest, tallest first, into a fresh texture of the same size
   * (this also recovers the space shelves packed before a grow waste).
   * False when it can't make room: nothing to drop and already packed
   * that way. */
  private compact(): boolean {
    const keep: [string, Entry][] = []
    for (const kv of this.entries) {
      // Used in this round or the last: a record later in the round
      // being uploaded still holds it from the last one.
      if (kv[1].used >= this.epoch - 1) {
        keep.push(kv)
      }
    }
    const before = this.entries.size
    if (keep.length === before && this.packedClean) {
      return false
    }
    keep.sort((a, b) => b[1].rect.h - a[1].rect.h)
    this.entries = new Map()
    this.shelfX = 0
    this.shelfY = 0
    this.shelfH = 0
    const texture = this.createTexture(this.size)
    const moves: [AtlasRect, number, number][] = []
    for (const [k, e] of keep) {
      const spot = this.pack(e.rect.w, e.rect.h)
      if (!spot) {
        continue
      }
      moves.push([e.rect, spot.x, spot.y])
      this.entries.set(k, {
        rect: { x: spot.x, y: spot.y, w: e.rect.w, h: e.rect.h },
        used: e.used
      })
    }
    this.copyInto(texture, moves)
    this.replace(texture, this.size)
    this.packedClean = true
    log.info(
      `ImageAtlas: repacked, ${before - keep.length} unused entries dropped`
    )
    return true
  }

  private replace(texture: GPUTexture, size: number): void {
    this.texture?.destroy()
    this.texture = texture
    this.view = texture.createView()
    this.size = size
    this.generation++
    this.mipsDirty = true
  }

  /**
   * Pack + upload `source` (size `w`x`h`) if it fits, returning its rect in
   * atlas px, or null when it's ineligible or the atlas is full — the caller
   * should fall back to a standalone texture. Idempotent: a source already
   * in the atlas (by key) returns its existing rect without re-uploading
   * pixels. `explicitKey` lets a caller key a canvas source itself (e.g. an
   * SVG rasterised at display size, keyed by `src@WxH`) — a canvas has no
   * URL of its own to derive one from. The atlas keeps only the pixels,
   * never `source`.
   */
  add(
    source: AtlasCopySource,
    w: number,
    h: number,
    explicitKey?: string
  ): AtlasRect | null {
    if (w <= 0 || h <= 0) {
      return null
    }
    if (Math.max(w, h) > MAX_ENTRY_SIZE) {
      return null
    }
    const k = explicitKey ?? key(source as HTMLImageElement, w, h)
    const hit = this.entries.get(k)
    if (hit) {
      hit.used = this.epoch
      return hit.rect
    }
    this.ensureTexture()
    let spot = this.pack(w, h)
    if (!spot && this.grow()) {
      spot = this.pack(w, h)
    }
    if (!spot && this.compact()) {
      spot = this.pack(w, h)
    }
    if (!spot) {
      if (!this.warnedFull) {
        this.warnedFull = true
        log.warn(`ImageAtlas: ${this.size}px atlas full — falling back`)
      }
      return null
    }
    copyExternalImage(
      this.device,
      { source: source as GPUCopyExternalImageSource },
      { texture: this.texture as GPUTexture, origin: [spot.x, spot.y] },
      [w, h],
      // A re-issued upload (see copyExternalImage) goes where the entry is
      // by then: a grow or compact may have moved it to a new texture.
      () => {
        const e = this.entries.get(k)
        if (!e || !this.texture) {
          return null
        }
        this.mipsDirty = true
        return { texture: this.texture, origin: [e.rect.x, e.rect.y] }
      }
    )
    const rect: AtlasRect = { x: spot.x, y: spot.y, w, h }
    this.entries.set(k, { rect, used: this.epoch })
    this.packedClean = false
    this.mipsDirty = true
    return rect
  }

  /** Pure lookup: the rect already packed under `explicitKey`, or null if
   * nothing has been packed for it yet. Never packs or copies — used by a
   * caller (e.g. `ImagePass`'s async bitmap cache) that must not trigger a
   * synchronous copy before it has real pixels to copy from. Marks the
   * entry used (see `beginUse`). */
  get(explicitKey: string): AtlasRect | null {
    const e = this.entries.get(explicitKey)
    if (!e) {
      return null
    }
    e.used = this.epoch
    return e.rect
  }

  /** Regenerate the mip chain if the atlas changed since the last flush
   * (at most once per frame). */
  flush(encoder?: GPUCommandEncoder): void {
    if (!this.mipsDirty || !this.texture) {
      return
    }
    this.mips.generate(this.texture, mipLevelCountFor(this.size), encoder)
    this.mipsDirty = false
  }

  destroy(): void {
    this.texture?.destroy()
    this.texture = null
    this.view = null
  }
}
