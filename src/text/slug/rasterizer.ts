import type { Shared } from '../../gpu/frame'
import type { Scene } from '../../scene/scene'
import type { FontDescriptor } from '../../types'
import { log, reportShaderErrors } from '../../util/log'
import { resolveFontBytes } from '../fontSource'
import type { TextBackend } from '../textRasterizer'
import {
  type FontHandle,
  type ParsedFont,
  loadFontFile,
  makeInstance
} from './font'
import { SLUG_WGSL } from './shaders'

const GLYPH_FLOATS = 20 // rect(4)+offset(4)+color(4)+gref(4)+clip(4)
const BAND_COUNT = 16 // bands per glyph — must match font.ts bucketing
const CURVE_FLOATS = 8 // vec4 p + vec4 c

// Resident-glyph cache geometry. Each glyph occupies one fixed-size slot: 16
// bands + up to MAX_CURVES banded curves. Fixed stride means O(1) eviction and
// no fragmentation, at the cost of space for simple glyphs and a curve budget
// that skips pathologically complex glyphs. All three are safe to tune.
const SLOT_COUNT = 1024
const MAX_CURVES = 512

type BBox = { x1: number; y1: number; x2: number; y2: number }

interface FaceEntry {
  idx: number
  family: string
  weight: number
  italic: boolean
  font: ParsedFont
}

/**
 * Slug text backend: atlas-free, outline-based glyph rendering.
 *
 * Faces are parsed once (family/weight/italic) and each run resolves to its
 * best-matching face. Glyph outlines are uploaded lazily, on first on-screen
 * use, into a fixed pool of resident slots with LRU eviction — so coverage is
 * not limited to a pre-baked character set and memory tracks what is visible.
 *
 * Fonts are supplied as bytes (FontFace doesn't expose its parsed bytes); the
 * WGSL is validated in the playground — WebGPU can't run headless.
 */
export class SlugText implements TextBackend {
  readonly name = 'slug'
  readonly layer = 'text' as const
  ready = false

  private pipeline: GPURenderPipeline
  private layout: GPUBindGroupLayout
  private glyphBuf: GPUBuffer | null = null
  private readonly bandBuf: GPUBuffer
  private readonly curveBuf: GPUBuffer
  private bindGroup: GPUBindGroup | null = null
  private glyphCapacity = 0
  private count = 0
  private glyphBytes = new ArrayBuffer(0)
  private glyphF32 = new Float32Array(0)
  private glyphU32 = new Uint32Array(0)

  private faces: FaceEntry[] = []
  private loadedKeys = new Set<string>()
  private resolveCache = new Map<string, FaceEntry | null>()
  // Variable fonts are kept as sources and instanced to exact weights on
  // demand, so one file backs every weight the page uses.
  private variableSources: {
    family: string
    italic: boolean
    handle: FontHandle
    min: number
    max: number
  }[] = []
  private instanced = new Map<string, FaceEntry>()

  // Resident-glyph LRU. `cache` maps a glyph key to its slot; Map insertion
  // order is the recency order (oldest first), so the LRU victim is the first
  // key. `slotFrame` pins slots touched in the current upload.
  private cache = new Map<number, number>()
  private slotBBox: BBox[] = new Array(SLOT_COUNT)
  private slotFrame = new Int32Array(SLOT_COUNT)
  private nextFree = 0
  private frameId = 0
  private overflowed = false
  private warnedBudget = false
  private readonly bandScratch = new Float32Array(BAND_COUNT * 4)
  private readonly curveScratch = new Float32Array(MAX_CURVES * CURVE_FLOATS)

  constructor(private readonly shared: Shared) {
    const { device, format, frameLayout } = shared
    this.layout = device.createBindGroupLayout({
      entries: [0, 1, 2].map((binding) => ({
        binding,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'read-only-storage' as const }
      }))
    })
    const module = device.createShaderModule({ code: SLUG_WGSL })
    reportShaderErrors(module, 'slug')
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [frameLayout, this.layout]
      }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
            }
          }
        ]
      },
      primitive: { topology: 'triangle-list' }
    })

    this.bandBuf = device.createBuffer({
      size: SLOT_COUNT * BAND_COUNT * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.curveBuf = device.createBuffer({
      size: SLOT_COUNT * MAX_CURVES * CURVE_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.ensureGlyphCapacity(256)
  }

  /**
   * Resolve each FontFace to its bytes (via the page's @font-face src URLs) and
   * register it. Idempotent: faces already loaded here or via loadFontBuffer are
   * skipped, so it is safe to call again as document.fonts grows.
   */
  async prepare(faces: FontFace[]): Promise<void> {
    if (faces.length === 0) {
      log.info('SlugText.prepare: no fonts provided')
      return
    }
    const resolved = await resolveFontBytes(faces)
    for (const { buffer, descriptor } of resolved) {
      if (this.loadedKeys.has(faceKey(descriptor))) continue
      try {
        this.loadFontBuffer(buffer, descriptor)
      } catch (err) {
        log.info(
          `SlugText: could not parse ${descriptor.family ?? '(any)'} — ${
            (err as Error).message
          }`
        )
      }
    }
  }

  /**
   * Parse a font and register it as a resolvable face. Glyph outlines are NOT
   * uploaded here — they load on demand at draw time (see ensureResident).
   */
  loadFontBuffer(buffer: ArrayBuffer, descriptor: FontDescriptor = {}): void {
    const handle = loadFontFile(buffer)
    const family = (descriptor.family ?? '').toLowerCase()
    const italic = descriptor.italic ?? false
    this.loadedKeys.add(faceKey(descriptor))
    this.resolveCache.clear()
    this.ready = true

    if (handle.wght) {
      this.variableSources.push({
        family,
        italic,
        handle,
        min: handle.wght.min,
        max: handle.wght.max
      })
      log.info(
        `SlugText: +variable ${descriptor.family ?? '(any)'} wght ${
          handle.wght.min
        }-${handle.wght.max}`
      )
      return
    }

    this.faces.push({
      idx: this.faces.length,
      family,
      weight: descriptor.weight ?? 400,
      italic,
      font: makeInstance(handle, this.faces.length)
    })
    log.info(
      `SlugText: +face ${descriptor.family ?? '(any)'} ${
        descriptor.weight ?? 400
      }${italic ? 'i' : ''} — ${this.faces.length} face(s)`
    )
  }

  /** Best-matching face for a run: family, then italic, then nearest weight. */
  private resolveFace(
    family: string,
    weight: number,
    italic: boolean
  ): FaceEntry | null {
    if (this.faces.length === 0 && this.variableSources.length === 0) {
      return null
    }
    const key = `${family}|${weight}|${italic ? 1 : 0}`
    const cached = this.resolveCache.get(key)
    if (cached !== undefined) return cached

    const fam = family.toLowerCase()
    // Prefer a family-matching variable font (exact weight), then a static
    // face, then any variable font as a last resort.
    const best =
      this.instanceFor(fam, weight, italic) ??
      this.bestStatic(fam, weight, italic) ??
      this.instanceFor(null, weight, italic)
    this.resolveCache.set(key, best)
    return best
  }

  /** Nearest static face by family, then italic, then weight. */
  private bestStatic(
    fam: string,
    weight: number,
    italic: boolean
  ): FaceEntry | null {
    if (this.faces.length === 0) return null
    let pool = this.faces.filter((f) => f.family === fam)
    if (pool.length === 0) pool = this.faces
    const italicPool = pool.filter((f) => f.italic === italic)
    if (italicPool.length > 0) pool = italicPool

    let best = pool[0] ?? null
    let bestDiff = best
      ? Math.abs(best.weight - weight)
      : Number.POSITIVE_INFINITY
    for (const f of pool) {
      const d = Math.abs(f.weight - weight)
      if (d < bestDiff) {
        best = f
        bestDiff = d
      }
    }
    return best
  }

  /**
   * Instance a variable source at (clamped) `weight`, caching one face per
   * distinct weight. `fam === null` matches any source. Returns null if no
   * variable source qualifies.
   */
  private instanceFor(
    fam: string | null,
    weight: number,
    italic: boolean
  ): FaceEntry | null {
    let pool = this.variableSources
    if (fam !== null) pool = pool.filter((v) => v.family === fam)
    if (pool.length === 0) return null
    const italicPool = pool.filter((v) => v.italic === italic)
    const src = italicPool[0] ?? pool[0]
    if (!src) return null

    const w = Math.max(src.min, Math.min(src.max, weight))
    const instKey = `${src.family}|${w}|${italic ? 1 : 0}`
    const existing = this.instanced.get(instKey)
    if (existing) return existing

    const idx = this.faces.length
    const face: FaceEntry = {
      idx,
      family: src.family,
      weight: w,
      italic,
      font: makeInstance(src.handle, idx, { wght: w })
    }
    this.faces.push(face)
    this.instanced.set(instKey, face)
    log.info(`SlugText: instanced ${src.family || '(any)'} @ wght ${w}`)
    return face
  }

  /**
   * Ensure a glyph's bands/curves are resident and return its slot index (or -1
   * if it can't be placed this frame). Loads on miss, evicting the LRU slot when
   * the pool is full — but never a slot already used in the current upload.
   */
  private ensureResident(face: FaceEntry, glyphIndex: number): number {
    const key = face.idx * (1 << 20) + glyphIndex
    const hit = this.cache.get(key)
    if (hit !== undefined) {
      this.cache.delete(key) // re-insert as most-recently-used
      this.cache.set(key, hit)
      this.slotFrame[hit] = this.frameId
      return hit
    }

    let slot: number
    if (this.nextFree < SLOT_COUNT) {
      slot = this.nextFree++
    } else {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey === undefined) return -1
      const victim = this.cache.get(oldestKey) as number
      if (this.slotFrame[victim] === this.frameId) {
        this.overflowed = true // every slot is pinned by this frame
        return -1
      }
      this.cache.delete(oldestKey)
      slot = victim
    }

    if (!this.writeSlot(slot, face.font, glyphIndex)) return -1
    this.slotFrame[slot] = this.frameId
    this.cache.set(key, slot)
    return slot
  }

  /** Upload one glyph's bands + curves into a slot. False if over budget. */
  private writeSlot(
    slot: number,
    font: ParsedFont,
    glyphIndex: number
  ): boolean {
    const gb = font.glyph(glyphIndex)
    if (gb.curves.length > MAX_CURVES) {
      if (!this.warnedBudget) {
        this.warnedBudget = true
        log.info(
          `SlugText: glyph ${glyphIndex} exceeds MAX_CURVES (${
            gb.curves.length
          } > ${MAX_CURVES}); skipped`
        )
      }
      return false
    }
    const curveBase = slot * MAX_CURVES
    const b = this.bandScratch
    for (let i = 0; i < BAND_COUNT; i++) {
      const band = gb.bands[i]
      const o = i * 4
      if (band) {
        b[o] = band.yMin
        b[o + 1] = band.yMax
        b[o + 2] = curveBase + band.start
        b[o + 3] = curveBase + band.end
      } else {
        b[o] = 0
        b[o + 1] = 0
        b[o + 2] = curveBase
        b[o + 3] = curveBase
      }
    }
    this.shared.device.queue.writeBuffer(
      this.bandBuf,
      slot * BAND_COUNT * 16,
      b.buffer,
      0,
      BAND_COUNT * 16
    )
    const c = this.curveScratch
    for (let j = 0; j < gb.curves.length; j++) {
      const q = gb.curves[j]
      const o = j * CURVE_FLOATS
      if (!q) continue
      c[o] = q.x0
      c[o + 1] = q.y0
      c[o + 2] = q.x1
      c[o + 3] = q.y1
      c[o + 4] = q.cx
      c[o + 5] = q.cy
      c[o + 6] = 0
      c[o + 7] = 0
    }
    if (gb.curves.length > 0) {
      this.shared.device.queue.writeBuffer(
        this.curveBuf,
        curveBase * CURVE_FLOATS * 4,
        c.buffer,
        0,
        gb.curves.length * CURVE_FLOATS * 4
      )
    }
    this.slotBBox[slot] = gb.bbox
    return true
  }

  private ensureGlyphCapacity(n: number): void {
    if (n <= this.glyphCapacity && this.glyphBuf) return
    const cap = Math.max(n, this.glyphCapacity ? this.glyphCapacity * 2 : 256)
    this.glyphBuf?.destroy()
    this.glyphBuf = this.shared.device.createBuffer({
      size: cap * GLYPH_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.glyphBytes = new ArrayBuffer(cap * GLYPH_FLOATS * 4)
    this.glyphF32 = new Float32Array(this.glyphBytes)
    this.glyphU32 = new Uint32Array(this.glyphBytes)
    this.glyphCapacity = cap
    this.rebuildBindGroup()
  }

  private rebuildBindGroup(): void {
    if (!this.glyphBuf) return
    this.bindGroup = this.shared.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.glyphBuf } },
        { binding: 1, resource: { buffer: this.bandBuf } },
        { binding: 2, resource: { buffer: this.curveBuf } }
      ]
    })
  }

  upload(scene: Scene): void {
    let total = 0
    for (const run of scene.runs) total += run.glyphs.length
    this.count = 0
    if (total === 0 || !this.ready) return
    this.ensureGlyphCapacity(total)
    this.frameId++
    this.overflowed = false
    const f = this.glyphF32
    const u = this.glyphU32
    let i = 0
    for (const run of scene.runs) {
      const face = this.resolveFace(run.fontFamily, run.fontWeight, run.italic)
      if (!face) {
        // No resolvable face: emit zero-rect instances so glyph index still
        // matches scene's cumulative count (Scene.batches indexes by it).
        for (let k = 0; k < run.glyphs.length; k++) {
          f.fill(0, i * GLYPH_FLOATS, (i + 1) * GLYPH_FLOATS)
          i++
        }
        continue
      }
      const font = face.font
      const ascPx = font.ascender
      const descPx = -font.descender
      const cl = run.clip
      const clMinX = cl ? cl.x : -1e9
      const clMinY = cl ? cl.y : -1e9
      const clMaxX = cl ? cl.x + cl.width : 1e9
      const clMaxY = cl ? cl.y + cl.height : 1e9
      for (const g of run.glyphs) {
        const gi = font.glyphForCodePoint(g.glyphId)
        const slot = this.ensureResident(face, gi)
        const base = i * GLYPH_FLOATS
        const F = g.fontSize
        const asc = ascPx * F
        const desc = descPx * F
        const halfLead = (g.rect.height - (asc + desc)) / 2
        const baseline = g.rect.y + halfLead + asc
        const bbox = slot >= 0 ? this.slotBBox[slot] : undefined
        if (bbox) {
          f[base + 0] = g.rect.x + bbox.x1 * F
          f[base + 1] = baseline - bbox.y2 * F
          f[base + 2] = (bbox.x2 - bbox.x1) * F
          f[base + 3] = (bbox.y2 - bbox.y1) * F
        } else {
          f[base + 0] = g.rect.x
          f[base + 1] = g.rect.y
          f[base + 2] = g.rect.width
          f[base + 3] = g.rect.height
        }
        f[base + 4] = g.offset.x
        f[base + 5] = g.offset.y
        f[base + 6] = 0
        f[base + 7] = 0
        f[base + 8] = g.color.r
        f[base + 9] = g.color.g
        f[base + 10] = g.color.b
        f[base + 11] = g.color.a * run.opacity
        u[base + 12] = slot >= 0 ? slot * BAND_COUNT : 0
        u[base + 13] = slot >= 0 ? BAND_COUNT : 0
        u[base + 14] = 0
        u[base + 15] = 0
        f[base + 16] = clMinX
        f[base + 17] = clMinY
        f[base + 18] = clMaxX
        f[base + 19] = clMaxY
        i++
      }
    }
    this.count = i
    if (this.overflowed) {
      log.info(
        `SlugText: glyph cache overflow — >${SLOT_COUNT} distinct glyphs in one frame; raise SLOT_COUNT`
      )
    }
    if (i === 0) return
    this.shared.device.queue.writeBuffer(
      this.glyphBuf as GPUBuffer,
      0,
      this.glyphBytes,
      0,
      i * GLYPH_FLOATS * 4
    )
  }

  draw(encoder: GPURenderPassEncoder, first: number, count: number): void {
    if (!this.ready || this.count === 0 || count === 0 || !this.bindGroup)
      return
    encoder.setPipeline(this.pipeline)
    encoder.setBindGroup(1, this.bindGroup)
    encoder.draw(6, count, 0, first)
  }

  destroy(): void {
    this.glyphBuf?.destroy()
    this.bandBuf.destroy()
    this.curveBuf.destroy()
  }
}

/** Stable key for a face descriptor: family (ci) + weight + italic. */
function faceKey(d: {
  family?: string
  weight?: number
  italic?: boolean
}): string {
  return `${(d.family ?? '').toLowerCase()}|${d.weight ?? 400}|${
    d.italic ? 1 : 0
  }`
}
