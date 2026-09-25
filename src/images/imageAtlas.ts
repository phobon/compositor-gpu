import { MipGenerator, mipLevelCountFor } from '../gpu/mips'
import { copyExternalImage } from '../gpu/upload'
import { log } from '../util/log'

/** Transparent border kept around every entry, in atlas px (mip bleeding). */
export const GUTTER = 4
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
  source: AtlasSource
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
 * No eviction yet (`count` only grows) — a full atlas just stops accepting
 * new entries (logged once) and the caller falls back to a standalone
 * texture for anything that doesn't fit.
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

  private createTexture(size: number): GPUTexture {
    return this.device.createTexture({
      label: `image-atlas ${size}`,
      size: [size, size],
      format: 'rgba8unorm',
      mipLevelCount: mipLevelCountFor(size),
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT
    })
  }

  /** Shelf-pack a `w`x`h` cell (plus its gutter). Null if it can't fit at
   * the current size. */
  private pack(w: number, h: number): { x: number; y: number } | null {
    const cw = w + 2 * GUTTER
    const ch = h + 2 * GUTTER
    const s = this.size
    if (cw > s || ch > s) {
      return null
    }
    if (this.shelfX + cw > s) {
      this.shelfY += this.shelfH
      this.shelfX = 0
      this.shelfH = 0
    }
    if (this.shelfY + ch > s) {
      return null
    }
    const x = this.shelfX + GUTTER
    const y = this.shelfY + GUTTER
    this.shelfX += cw
    this.shelfH = Math.max(this.shelfH, ch)
    return { x, y }
  }

  /** Re-create the texture one step bigger (2048 -> 4096, capped at
   * `device.limits.maxTextureDimension2D`) and re-upload every live entry
   * at its existing coordinates — packing state is untouched, only the
   * backing texture grows. An entry whose live `<img>` no longer shows
   * what it was keyed by (`src` or natural size changed) is dropped rather
   * than re-copied with the wrong pixels; its space is not reclaimed.
   * False if already at the cap. */
  private grow(): boolean {
    const max = this.maxSize()
    if (this.size >= max) {
      return false
    }
    const newSize = Math.min(this.size * 2, max)
    const texture = this.createTexture(newSize)
    for (const [k, e] of this.entries) {
      const img = e.source
      const live =
        !(img instanceof HTMLImageElement) ||
        (img.complete &&
          img.naturalWidth === e.rect.w &&
          img.naturalHeight === e.rect.h &&
          key(img, e.rect.w, e.rect.h) === k)
      if (!live) {
        this.entries.delete(k)
        continue
      }
      copyExternalImage(
        this.device,
        { source: e.source },
        { texture, origin: [e.rect.x, e.rect.y] },
        [e.rect.w, e.rect.h]
      )
    }
    this.texture?.destroy()
    this.texture = texture
    this.view = texture.createView()
    this.size = newSize
    this.generation++
    this.mipsDirty = true
    return true
  }

  /**
   * Pack + upload `source` (size `w`x`h`) if it fits, returning its rect in
   * atlas px, or null when it's ineligible or the atlas is full — the caller
   * should fall back to a standalone texture. Idempotent: a source already
   * in the atlas (by key) returns its existing rect without re-uploading
   * pixels. `explicitKey` lets a caller key a canvas source itself (e.g. an
   * SVG rasterised at display size, keyed by `src@WxH`) — a canvas has no
   * URL of its own to derive one from. `trackSource`, when given, is what
   * gets recorded for later `grow()` revalidation instead of `source` — an
   * `ImageBitmap` is transient (the caller closes it right after this call),
   * so a bitmap-backed entry tracks the originating `<img>` instead; `grow()`
   * already drops an entry it can't revalidate against rather than
   * re-copying from the wrong pixels, so this never reintroduces the crop
   * `source` was decoded to avoid.
   */
  add(
    source: AtlasCopySource,
    w: number,
    h: number,
    explicitKey?: string,
    trackSource?: AtlasSource
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
      return hit.rect
    }
    this.ensureTexture()
    let spot = this.pack(w, h)
    if (!spot && this.grow()) {
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
      [w, h]
    )
    const rect: AtlasRect = { x: spot.x, y: spot.y, w, h }
    this.entries.set(k, {
      rect,
      source: trackSource ?? (source as AtlasSource)
    })
    this.mipsDirty = true
    return rect
  }

  /** Pure lookup: the rect already packed under `explicitKey`, or null if
   * nothing has been packed for it yet. Never packs or copies — used by a
   * caller (e.g. `ImagePass`'s async bitmap cache) that must not trigger a
   * synchronous copy before it has real pixels to copy from. */
  get(explicitKey: string): AtlasRect | null {
    return this.entries.get(explicitKey)?.rect ?? null
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
