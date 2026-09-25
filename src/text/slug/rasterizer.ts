import type { Shared } from '../../gpu/frame'
import type { Scene } from '../../scene/scene'
import type { FontDescriptor } from '../../types'
import { log, reportShaderErrors } from '../../util/log'
import { ATLAS_QUAD_FLOATS, ATLAS_WGSL } from '../atlasShader'
import { resolveFontBytes } from '../fontSource'
import { ATLAS_PAD, GlyphAtlas, isColorGrapheme } from '../glyphAtlas'
import type { TextBackend } from '../textRasterizer'
import {
  type FontHandle,
  type ParsedFont,
  loadFontFile,
  makeInstance
} from './font'
import { SLUG_WGSL } from './shaders'

// rect(4)+offset(4)+color(4)+gref(4)+clip(4)+xf0(4)+xf1(4). gref is u32,
// written through the shared u32 view of the same buffer.
const GLYPH_FLOATS = 28
/** tan(14°): the browser's synthetic-oblique shear. */
const OBLIQUE = Math.tan((14 * Math.PI) / 180)
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
  /** True once at least one Slug face is parsed (fallback draws regardless). */
  ready = false
  /** Glyphs drawn via the Canvas 2D fallback atlas in the last upload. */
  fallbackCount = 0

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

  // Fallback atlas quads: a second pipeline sharing the glyph index space.
  // Every glyph writes one instance into each buffer (zero-rect in the one
  // that doesn't draw it), so draw(first, count) is valid for both.
  private readonly atlas = new GlyphAtlas()
  private atlasPipeline: GPURenderPipeline
  private atlasLayout: GPUBindGroupLayout
  private readonly atlasSampler: GPUSampler
  private quadBuf: GPUBuffer | null = null
  private quadF32 = new Float32Array(0)
  private atlasBindGroup: GPUBindGroup | null = null
  private atlasGen = -1
  private slugLive = 0
  // face.idx * 2^21 + code point -> glyph index (0 = .notdef).
  private gidCache = new Map<number, number>()

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

    this.atlasLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' }
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} }
      ]
    })
    this.atlasSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge'
    })
    const atlasModule = device.createShaderModule({ code: ATLAS_WGSL })
    reportShaderErrors(atlasModule, 'text-atlas')
    this.atlasPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [frameLayout, this.atlasLayout]
      }),
      vertex: { module: atlasModule, entryPoint: 'vs' },
      fragment: {
        module: atlasModule,
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
    // face; faces registered without a family ('') match any run. A run
    // whose family has no face returns null and falls back to the atlas.
    const best =
      this.instanceFor(fam, weight, italic) ??
      this.bestStatic(fam, weight, italic) ??
      this.instanceFor('', weight, italic) ??
      this.bestStatic('', weight, italic)
    this.resolveCache.set(key, best)
    return best
  }

  /** Nearest static face by family, then italic, then weight. */
  private bestStatic(
    fam: string,
    weight: number,
    italic: boolean
  ): FaceEntry | null {
    let pool = this.faces.filter((f) => f.family === fam)
    if (pool.length === 0) return null
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
   * distinct weight. Returns null if no variable source of `fam` qualifies.
   */
  private instanceFor(
    fam: string,
    weight: number,
    italic: boolean
  ): FaceEntry | null {
    const pool = this.variableSources.filter((v) => v.family === fam)
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
      // The source's slant, not the requested one: an upright source
      // standing in for italic gets a synthetic oblique (see fill()).
      italic: src.italic,
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
    const device = this.shared.device
    this.glyphBuf?.destroy()
    this.glyphBuf = device.createBuffer({
      size: cap * GLYPH_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.glyphBytes = new ArrayBuffer(cap * GLYPH_FLOATS * 4)
    this.glyphF32 = new Float32Array(this.glyphBytes)
    this.glyphU32 = new Uint32Array(this.glyphBytes)
    this.quadBuf?.destroy()
    this.quadBuf = device.createBuffer({
      size: cap * ATLAS_QUAD_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.quadF32 = new Float32Array(cap * ATLAS_QUAD_FLOATS)
    this.glyphCapacity = cap
    this.rebuildBindGroup()
    this.atlasBindGroup = null
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

  /** Rebuild the atlas bind group if the quad buffer or texture changed. */
  private ensureAtlasBindGroup(): void {
    const view = this.atlas.view
    if (!this.quadBuf || !view) return
    if (this.atlasBindGroup && this.atlasGen === this.atlas.generation) return
    this.atlasBindGroup = this.shared.device.createBindGroup({
      layout: this.atlasLayout,
      entries: [
        { binding: 0, resource: { buffer: this.quadBuf } },
        { binding: 1, resource: view },
        { binding: 2, resource: this.atlasSampler }
      ]
    })
    this.atlasGen = this.atlas.generation
  }

  /** Cached cmap lookup; 0 is .notdef. */
  private glyphIndex(face: FaceEntry, cp: number): number {
    const key = face.idx * 0x200000 + cp
    let gi = this.gidCache.get(key)
    if (gi === undefined) {
      gi = face.font.glyphForCodePoint(cp)
      this.gidCache.set(key, gi)
    }
    return gi
  }

  upload(scene: Scene): void {
    let total = 0
    for (const run of scene.runs) total += run.glyphs.length
    this.count = 0
    this.slugLive = 0
    this.fallbackCount = 0
    if (total === 0) return
    this.ensureGlyphCapacity(total)
    this.frameId++
    this.overflowed = false
    const dpr = this.shared.dpr > 0 ? this.shared.dpr : 1
    // An atlas grow/clear mid-frame invalidates entries already written this
    // frame; one re-pack against the fresh atlas fixes that.
    const epoch = this.atlas.epoch
    let n = this.fill(scene, dpr)
    if (this.atlas.epoch !== epoch) n = this.fill(scene, dpr)
    this.count = n
    if (this.overflowed) {
      log.info(
        `SlugText: glyph cache overflow — >${SLOT_COUNT} distinct glyphs in one frame; raise SLOT_COUNT`
      )
    }
    if (n === 0) return
    const queue = this.shared.device.queue
    if (this.slugLive > 0) {
      queue.writeBuffer(
        this.glyphBuf as GPUBuffer,
        0,
        this.glyphBytes,
        0,
        n * GLYPH_FLOATS * 4
      )
    }
    if (this.fallbackCount > 0) {
      this.atlas.flush(this.shared.device)
      this.ensureAtlasBindGroup()
      queue.writeBuffer(
        this.quadBuf as GPUBuffer,
        0,
        this.quadF32.buffer,
        0,
        n * ATLAS_QUAD_FLOATS * 4
      )
    }
  }

  /** Write one Slug instance and one atlas quad per glyph; returns count. */
  private fill(scene: Scene, dpr: number): number {
    const f = this.glyphF32
    const u = this.glyphU32
    const q = this.quadF32
    const pad = ATLAS_PAD / dpr
    this.slugLive = 0
    this.fallbackCount = 0
    let i = 0
    for (const run of scene.runs) {
      const face = this.resolveFace(run.fontFamily, run.fontWeight, run.italic)
      const font = face?.font
      const ascPx = font ? font.ascender : 0
      const descPx = font ? -font.descender : 0
      const cl = run.clip
      const clMinX = cl ? cl.x : -1e9
      const clMinY = cl ? cl.y : -1e9
      const clMaxX = cl ? cl.x + cl.width : 1e9
      const clMaxY = cl ? cl.y + cl.height : 1e9
      const alpha = run.opacity
      // Italic requested but the face is upright: synthesise oblique like
      // the browser does (a shear about the baseline; Slug only — the atlas
      // rasterises with `italic` in the font string, so Canvas 2D does it).
      const oblique = face && run.italic && !face.italic ? OBLIQUE : 0
      for (const g of run.glyphs) {
        const base = i * GLYPH_FLOATS
        const qb = i * ATLAS_QUAD_FLOATS
        i++
        const gi = face ? this.slugGlyph(face, g.text, g.glyphId) : 0
        // Placement runs in the glyph's local line-box frame (origin at its
        // top-left, size g.local); xform maps it to doc space.
        const xf = g.xform
        if (face && font && gi > 0) {
          q.fill(0, qb, qb + ATLAS_QUAD_FLOATS)
          const slot = this.ensureResident(face, gi)
          const F = g.fontSize
          const asc = ascPx * F
          const desc = descPx * F
          const halfLead = (g.local.h - (asc + desc)) / 2
          const baseline = halfLead + asc
          const bbox = slot >= 0 ? this.slotBBox[slot] : undefined
          if (bbox) {
            f[base + 0] = bbox.x1 * F
            f[base + 1] = baseline - bbox.y2 * F
            f[base + 2] = (bbox.x2 - bbox.x1) * F
            f[base + 3] = (bbox.y2 - bbox.y1) * F
          } else {
            f[base + 0] = 0
            f[base + 1] = 0
            f[base + 2] = g.local.w
            f[base + 3] = g.local.h
          }
          f[base + 4] = g.offset.x
          f[base + 5] = g.offset.y
          f[base + 6] = 0
          f[base + 7] = 0
          f[base + 8] = g.color.r
          f[base + 9] = g.color.g
          f[base + 10] = g.color.b
          f[base + 11] = g.color.a * alpha
          u[base + 12] = slot >= 0 ? slot * BAND_COUNT : 0
          u[base + 13] = slot >= 0 ? BAND_COUNT : 0
          u[base + 14] = 0
          u[base + 15] = 0
          f[base + 16] = clMinX
          f[base + 17] = clMinY
          f[base + 18] = clMaxX
          f[base + 19] = clMaxY
          // xform · shear, the shear [1, 0, -k, 1] taken about local y =
          // baseline: x' = x + k (baseline - y).
          const kb = oblique * baseline
          f[base + 20] = xf[0]
          f[base + 21] = xf[1]
          f[base + 22] = xf[2] - oblique * xf[0]
          f[base + 23] = xf[3] - oblique * xf[1]
          f[base + 24] = xf[4] + xf[0] * kb
          f[base + 25] = xf[5] + xf[1] * kb
          f[base + 26] = 0
          f[base + 27] = 0
          if (slot >= 0) this.slugLive++
          continue
        }

        // Fallback: the browser rasterises the grapheme into the atlas.
        f.fill(0, base, base + GLYPH_FLOATS)
        const e = this.atlas.get(
          g.text,
          run.fontStack,
          run.fontWeight,
          run.italic,
          Math.max(1, Math.round(g.fontSize * dpr)),
          g.color
        )
        if (!e) {
          q.fill(0, qb, qb + ATLAS_QUAD_FLOATS)
          continue
        }
        // Same line-box centring rule as Slug, with the browser's metrics,
        // in the local frame. Untransformed glyphs are snapped to device px
        // so texels land 1:1 on the target; transformed ones can't be.
        const asc = e.ascentPx / dpr
        const desc = e.descentPx / dpr
        let baseline = (g.local.h - (asc + desc)) / 2 + asc
        let penX = 0
        const tx = xf[4]
        const ty = xf[5]
        if (xf[0] === 1 && xf[1] === 0 && xf[2] === 0 && xf[3] === 1) {
          baseline = Math.round((ty + baseline) * dpr) / dpr - ty
          penX = Math.round(tx * dpr) / dpr - tx
        }
        q[qb + 0] = penX - e.leftPx / dpr - pad
        q[qb + 1] = baseline - e.cellAscPx / dpr - pad
        q[qb + 2] = e.w / dpr
        q[qb + 3] = e.h / dpr
        q[qb + 4] = e.u0
        q[qb + 5] = e.v0
        q[qb + 6] = e.u1
        q[qb + 7] = e.v1
        q[qb + 8] = g.color.r
        q[qb + 9] = g.color.g
        q[qb + 10] = g.color.b
        q[qb + 11] = g.color.a * alpha
        q[qb + 12] = e.tint ? 1 : 0
        q[qb + 13] = 0
        q[qb + 14] = 0
        q[qb + 15] = 0
        q[qb + 16] = clMinX
        q[qb + 17] = clMinY
        q[qb + 18] = clMaxX
        q[qb + 19] = clMaxY
        q[qb + 20] = xf[0]
        q[qb + 21] = xf[1]
        q[qb + 22] = xf[2]
        q[qb + 23] = xf[3]
        q[qb + 24] = tx + g.offset.x
        q[qb + 25] = ty + g.offset.y
        q[qb + 26] = 0
        q[qb + 27] = 0
        this.fallbackCount++
      }
    }
    return i
  }

  /**
   * Slug glyph index for a grapheme, or 0 when it must fall back: colour /
   * emoji, a multi-code-point cluster we can't shape (variation selectors
   * aside), or a code point the face has no glyph for.
   */
  private slugGlyph(face: FaceEntry, text: string, cp: number): number {
    if (isColorGrapheme(text)) return 0
    let n = 0
    for (const ch of text) {
      const c = ch.codePointAt(0) ?? 0
      if (!isVariationSelector(c)) n++
    }
    if (n > 1) return 0
    return this.glyphIndex(face, cp)
  }

  draw(encoder: GPURenderPassEncoder, first: number, count: number): number {
    if (this.count === 0 || count === 0) return 0
    let draws = 0
    if (this.ready && this.slugLive > 0 && this.bindGroup) {
      encoder.setPipeline(this.pipeline)
      encoder.setBindGroup(1, this.bindGroup)
      encoder.draw(6, count, 0, first)
      draws++
    }
    if (this.fallbackCount > 0 && this.atlasBindGroup) {
      encoder.setPipeline(this.atlasPipeline)
      encoder.setBindGroup(1, this.atlasBindGroup)
      encoder.draw(6, count, 0, first)
      draws++
    }
    return draws
  }

  destroy(): void {
    this.glyphBuf?.destroy()
    this.quadBuf?.destroy()
    this.bandBuf.destroy()
    this.curveBuf.destroy()
    this.atlas.destroy()
  }
}

/** U+FE00–FE0F and U+E0100–E01EF. */
function isVariationSelector(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)
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
