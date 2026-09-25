import type { Shared } from '../../gpu/frame'
import type { Glyph, RGBA, TextShadow } from '../../scene/records'
import type { Scene } from '../../scene/scene'
import type { FontDescriptor } from '../../types'
import { log, reportShaderErrors } from '../../util/log'
import { ATLAS_QUAD_FLOATS, ATLAS_WGSL } from '../atlasShader'
import { resolveFontBytes } from '../fontSource'
import { ATLAS_PAD, type AtlasEntry, GlyphAtlas } from '../glyphAtlas'
import type { TextBackend } from '../textRasterizer'
import {
  type FontHandle,
  type GlyphBands,
  loadFontFile,
  makeInstance,
  type ParsedFont
} from './font'
import { SLUG_WGSL } from './shaders'

// rect(4)+offset(4)+color(4)+gref(4)+clip(4)+xf0(4)+xf1(4). gref is u32,
// written through the shared u32 view of the same buffer.
const GLYPH_FLOATS = 28
/** Max gap (px) between a component's right edge and the next one's left
 * edge for them to count as one ligature: Chrome's split rects abut. */
const LIGATURE_GAP = 1.5
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
 * Fonts are supplied as bytes: `prepare()` resolves each `FontFace`'s
 * `@font-face` `url()` and fetches them at runtime (`text/fontSource.ts`),
 * since `FontFace` itself doesn't expose its parsed bytes. The WGSL is
 * validated by the visual-regression harness (headless WebGPU via
 * SwiftShader) and offline with `naga`.
 */
export class SlugText implements TextBackend {
  readonly name = 'slug'
  readonly layer = 'text' as const
  /** True once at least one Slug face is parsed (fallback draws regardless). */
  ready = false
  /** Glyphs drawn via the Canvas 2D fallback atlas in the last upload. */
  fallbackCount = 0
  /** Ligature glyphs formed in the last upload (components merged). */
  ligatureCount = 0
  /** `"family weight[i]"` labels of faces `prepare()` couldn't resolve (no
   * matching @font-face src, or its url() didn't fetch). Runs using them
   * fall back to the Canvas 2D atlas. */
  readonly failedFaces: string[] = []

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
  /** Non-zero atlas quads (fallback glyphs + atlas-drawn text shadows). */
  private atlasLive = 0
  /** Glyphs + text-shadow instances written by the last upload. */
  private instances = 0
  /** Per glyph index: start of its run's shadow range (see fill). */
  private shadowStart = new Uint32Array(0)
  /** The current run's doc-space clip (minX, minY, maxX, maxY). */
  private readonly clip = new Float64Array(4)
  /** The current run's space flag (1 = viewport, see frame.ts to_clip). */
  private space = 0
  // face.idx * 2^21 + code point -> glyph index (0 = .notdef).
  private gidCache = new Map<number, number>()
  // Per-run Slug glyph ids (0 = fallback), reused across runs.
  private idScratch: number[] = []

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
  /** Glyph keys refused for exceeding MAX_CURVES (drawn via the atlas). */
  private readonly refused = new Set<number>()
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
    const { resolved, failed } = await resolveFontBytes(faces)
    for (const label of failed) {
      if (!this.failedFaces.includes(label)) {
        this.failedFaces.push(label)
      }
    }
    for (const { buffer, descriptor } of resolved) {
      if (this.loadedKeys.has(faceKey(descriptor))) {
        continue
      }
      try {
        this.loadFontBuffer(buffer, descriptor)
      } catch (err) {
        log.info(
          `SlugText: could not parse ${descriptor.family ?? '(any)'} — ${
            (err as Error).message
          }`
        )
        this.failedFaces.push(
          `${descriptor.family ?? '(any)'} ${descriptor.weight}${
            descriptor.italic ? 'i' : ''
          }`
        )
      }
    }
  }

  /** Registered faces (static + variable sources), for `stats().faces`. */
  get faceCount(): number {
    return this.faces.length + this.variableSources.length
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
    if (cached !== undefined) {
      return cached
    }

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
    if (pool.length === 0) {
      return null
    }
    const italicPool = pool.filter((f) => f.italic === italic)
    if (italicPool.length > 0) {
      pool = italicPool
    }

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
    if (pool.length === 0) {
      return null
    }
    const italicPool = pool.filter((v) => v.italic === italic)
    const src = italicPool[0] ?? pool[0]
    if (!src) {
      return null
    }

    const w = Math.max(src.min, Math.min(src.max, weight))
    const instKey = `${src.family}|${w}|${italic ? 1 : 0}`
    const existing = this.instanced.get(instKey)
    if (existing) {
      return existing
    }

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

    const gb = face.font.glyph(glyphIndex)
    if (this.refuse(key, gb.curves.length, glyphIndex)) {
      return -1
    }

    let slot: number
    if (this.nextFree < SLOT_COUNT) {
      slot = this.nextFree++
    } else {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey === undefined) {
        return -1
      }
      const victim = this.cache.get(oldestKey) as number
      if (this.slotFrame[victim] === this.frameId) {
        this.overflowed = true // every slot is pinned by this frame
        return -1
      }
      this.cache.delete(oldestKey)
      slot = victim
    }

    this.writeSlot(slot, gb)
    this.slotFrame[slot] = this.frameId
    this.cache.set(key, slot)
    return slot
  }

  /**
   * True when a glyph can't be resident (more than MAX_CURVES curves).
   * Remembered per key so the check and the log happen once; callers route
   * refused glyphs to the fallback atlas (see `fits`).
   */
  private refuse(key: number, curves: number, glyphIndex: number): boolean {
    if (this.refused.has(key)) {
      return true
    }
    if (curves <= MAX_CURVES) {
      return false
    }
    this.refused.add(key)
    if (!this.warnedBudget) {
      this.warnedBudget = true
      log.info(
        `SlugText: glyph ${glyphIndex} exceeds MAX_CURVES (${curves} > ${MAX_CURVES}); drawn via the fallback atlas`
      )
    }
    return true
  }

  /** Can this glyph be drawn by Slug (resident, or within the budget)? */
  private fits(face: FaceEntry, glyphIndex: number): boolean {
    const key = face.idx * (1 << 20) + glyphIndex
    if (this.cache.has(key)) {
      return true
    }
    if (this.refused.has(key)) {
      return false
    }
    const n = face.font.glyph(glyphIndex).curves.length
    return !this.refuse(key, n, glyphIndex)
  }

  /** Upload one glyph's bands + curves (≤ MAX_CURVES) into a slot. */
  private writeSlot(slot: number, gb: GlyphBands): void {
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
      if (!q) {
        continue
      }
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
  }

  private ensureGlyphCapacity(n: number): void {
    if (n <= this.glyphCapacity && this.glyphBuf) {
      return
    }
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
    if (!this.glyphBuf) {
      return
    }
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
    if (!this.quadBuf || !view) {
      return
    }
    if (this.atlasBindGroup && this.atlasGen === this.atlas.generation) {
      return
    }
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
    let shadowTotal = 0
    for (const run of scene.runs) {
      const n = run.glyphs.length
      total += n
      shadowTotal += n * (run.textShadows?.length ?? 0)
    }
    this.count = 0
    this.instances = 0
    this.slugLive = 0
    this.atlasLive = 0
    this.fallbackCount = 0
    this.ligatureCount = 0
    if (total === 0) {
      return
    }
    this.ensureGlyphCapacity(total + shadowTotal)
    if (this.shadowStart.length < total + 1) {
      this.shadowStart = new Uint32Array(
        Math.max(total + 1, this.shadowStart.length * 2)
      )
    }
    this.frameId++
    this.overflowed = false
    const dpr = this.shared.dpr > 0 ? this.shared.dpr : 1
    // An atlas grow/clear mid-frame invalidates entries already written this
    // frame; one re-pack against the fresh atlas fixes that.
    const epoch = this.atlas.epoch
    let n = this.fill(scene, dpr, total)
    if (this.atlas.epoch !== epoch) {
      n = this.fill(scene, dpr, total)
    }
    this.count = n
    this.instances = total + shadowTotal
    if (this.overflowed) {
      log.info(
        `SlugText: glyph cache overflow — >${SLOT_COUNT} distinct glyphs in one frame; raise SLOT_COUNT`
      )
    }
    if (n === 0) {
      return
    }
    const m = this.instances
    const queue = this.shared.device.queue
    if (this.slugLive > 0) {
      queue.writeBuffer(
        this.glyphBuf as GPUBuffer,
        0,
        this.glyphBytes,
        0,
        m * GLYPH_FLOATS * 4
      )
    }
    if (this.atlasLive > 0) {
      this.atlas.flush(this.shared.device)
      this.ensureAtlasBindGroup()
      queue.writeBuffer(
        this.quadBuf as GPUBuffer,
        0,
        this.quadF32.buffer,
        0,
        m * ATLAS_QUAD_FLOATS * 4
      )
    }
  }

  /**
   * Write one Slug instance and one atlas quad per glyph (indices
   * `[0, total)`, scene glyph order), then its text-shadow instances after
   * all glyphs: run r's shadows fill `[base_r, base_r + S·n)` layer-major
   * (layer k = CSS layer S−1−k, so bottom-most first; glyph j of layer k at
   * `base_r + k·n + j`), again one real + one zero instance per pipeline.
   * `shadowStart[g]` is base_r for a run's first glyph and the run's end
   * for the rest, so a batch of whole runs `[first, first + count)` owns the
   * shadow range `[shadowStart[first], shadowStart[first + count])`.
   * Returns the glyph count.
   */
  private fill(scene: Scene, dpr: number, total: number): number {
    const f = this.glyphF32
    const u = this.glyphU32
    const q = this.quadF32
    const pad = ATLAS_PAD / dpr
    const starts = this.shadowStart
    this.slugLive = 0
    this.atlasLive = 0
    this.fallbackCount = 0
    this.ligatureCount = 0
    const ids = this.idScratch
    let i = 0
    let sCursor = total
    for (const run of scene.runs) {
      const face = this.resolveFace(run.fontFamily, run.fontWeight, run.italic)
      const font = face?.font
      const ascPx = font ? font.ascender : 0
      const descPx = font ? -font.descender : 0
      const cl = run.clip
      const clip = this.clip
      clip[0] = cl ? cl.x : -1e9
      clip[1] = cl ? cl.y : -1e9
      clip[2] = cl ? cl.x + cl.width : 1e9
      clip[3] = cl ? cl.y + cl.height : 1e9
      this.space = run.space === 'viewport' ? 1 : 0
      const alpha = run.opacity
      // Italic requested but the face is upright: synthesise oblique like
      // the browser does (a shear about the baseline; Slug only — the atlas
      // rasterises with `italic` in the font string, so Canvas 2D does it).
      const oblique = face && run.italic && !face.italic ? OBLIQUE : 0
      const glyphs = run.glyphs
      const nGlyphs = glyphs.length
      const shadows = run.textShadows ?? NO_SHADOWS
      const S = shadows.length
      const runBase = sCursor
      sCursor += S * nGlyphs
      ids.length = nGlyphs
      for (let j = 0; j < nGlyphs; j++) {
        const g = glyphs[j] as Glyph
        const id = face ? this.slugGlyph(face, g) : 0
        // Over the curve budget: the atlas draws it instead.
        ids[j] = id > 0 && face && !this.fits(face, id) ? 0 : id
      }
      // Components of a ligature already drawn by an earlier instance.
      let consumed = 0
      for (let j = 0; j < nGlyphs; j++) {
        const g = glyphs[j] as Glyph
        starts[i] = j === 0 ? runBase : sCursor
        const base = i * GLYPH_FLOATS
        const qb = i * ATLAS_QUAD_FLOATS
        i++
        if (consumed > 0) {
          consumed--
          f.fill(0, base, base + GLYPH_FLOATS)
          q.fill(0, qb, qb + ATLAS_QUAD_FLOATS)
          for (let k = 0; k < S; k++) {
            this.zeroInstance(runBase + k * nGlyphs + j)
          }
          continue
        }
        let gi = ids[j] ?? 0
        // Local width of the drawn box: the union of a ligature's component
        // rects in the first component's frame (the pen origin is shared).
        let w = g.local.w
        let text = g.text
        if (gi > 0 && font && run.ligatures) {
          const lig = font.ligatureAt(ids, j)
          const right = lig ? ligatureRight(glyphs, j, lig.len) : null
          if (lig && right !== null && face && this.fits(face, lig.by)) {
            gi = lig.by
            w = right
            consumed = lig.len - 1
            this.ligatureCount++
            if (S > 0) {
              for (let k = 1; k < lig.len; k++) {
                text += glyphs[j + k]?.text ?? ''
              }
            }
          }
        }
        const sizePx = Math.max(1, Math.round(g.fontSize * dpr))
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
            f[base + 2] = w
            f[base + 3] = g.local.h
          }
          f[base + 4] = g.offset.x
          f[base + 5] = g.offset.y
          f[base + 6] = this.space
          f[base + 7] = 0
          f[base + 8] = g.color.r
          f[base + 9] = g.color.g
          f[base + 10] = g.color.b
          f[base + 11] = g.color.a * alpha
          u[base + 12] = slot >= 0 ? slot * BAND_COUNT : 0
          u[base + 13] = slot >= 0 ? BAND_COUNT : 0
          u[base + 14] = 0
          u[base + 15] = 0
          f[base + 16] = clip[0]
          f[base + 17] = clip[1]
          f[base + 18] = clip[2]
          f[base + 19] = clip[3]
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
          if (slot >= 0) {
            this.slugLive++
          }
          for (let k = 0; k < S; k++) {
            const sh = shadows[S - 1 - k] as TextShadow
            const si = runBase + k * nGlyphs + j
            if (sh.blur > 0) {
              f.fill(0, si * GLYPH_FLOATS, (si + 1) * GLYPH_FLOATS)
              const e = this.atlas.getShadow(
                text,
                run.fontStack,
                run.fontWeight,
                run.italic,
                sizePx,
                shadowBlurPx(sh.blur, dpr)
              )
              this.putQuad(si, e, g, dpr, pad, sh.color, alpha, sh.ox, sh.oy)
              continue
            }
            // Hard shadow: the same Slug glyph, moved and recoloured. The
            // rect is pre-shear, so pre-compensate x for the oblique.
            const sb = si * GLYPH_FLOATS
            q.fill(0, si * ATLAS_QUAD_FLOATS, (si + 1) * ATLAS_QUAD_FLOATS)
            u.copyWithin(sb, base, base + GLYPH_FLOATS)
            f[sb + 0] = (f[base + 0] ?? 0) + sh.ox + oblique * sh.oy
            f[sb + 1] = (f[base + 1] ?? 0) + sh.oy
            f[sb + 8] = sh.color.r
            f[sb + 9] = sh.color.g
            f[sb + 10] = sh.color.b
            f[sb + 11] = sh.color.a * alpha
          }
          continue
        }

        // Fallback: the browser rasterises the grapheme into the atlas.
        f.fill(0, base, base + GLYPH_FLOATS)
        const e = this.atlas.get(
          g.text,
          run.fontStack,
          run.fontWeight,
          run.italic,
          sizePx,
          g.color
        )
        this.putQuad(i - 1, e, g, dpr, pad, g.color, alpha, 0, 0, !e?.tint)
        if (e) {
          this.fallbackCount++
        }
        for (let k = 0; k < S; k++) {
          const sh = shadows[S - 1 - k] as TextShadow
          const si = runBase + k * nGlyphs + j
          f.fill(0, si * GLYPH_FLOATS, (si + 1) * GLYPH_FLOATS)
          const se = !e
            ? null
            : sh.blur > 0
              ? this.atlas.getShadow(
                  g.text,
                  run.fontStack,
                  run.fontWeight,
                  run.italic,
                  sizePx,
                  shadowBlurPx(sh.blur, dpr)
                )
              : e
          this.putQuad(si, se, g, dpr, pad, sh.color, alpha, sh.ox, sh.oy)
        }
      }
    }
    starts[i] = sCursor
    return i
  }

  /** Zero both pipelines' instance `k`. */
  private zeroInstance(k: number): void {
    this.glyphF32.fill(0, k * GLYPH_FLOATS, (k + 1) * GLYPH_FLOATS)
    this.quadF32.fill(0, k * ATLAS_QUAD_FLOATS, (k + 1) * ATLAS_QUAD_FLOATS)
  }

  /**
   * Write atlas quad `k` for entry `e` (zero when null) at glyph `g`'s pen
   * origin + (dx, dy) local px. Same line-box centring rule as Slug, with
   * the browser's metrics; untransformed glyphs are snapped to device px so
   * texels land 1:1 on the target. `colour`: keep the texel colours (colour
   * glyphs) instead of tinting coverage by `color`.
   */
  private putQuad(
    k: number,
    e: AtlasEntry | null,
    g: Glyph,
    dpr: number,
    pad: number,
    color: RGBA,
    alpha: number,
    dx: number,
    dy: number,
    colour = false
  ): void {
    const q = this.quadF32
    const qb = k * ATLAS_QUAD_FLOATS
    if (!e) {
      q.fill(0, qb, qb + ATLAS_QUAD_FLOATS)
      return
    }
    const xf = g.xform
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
    const clip = this.clip
    q[qb + 0] = penX + dx - e.leftPx / dpr - pad
    q[qb + 1] = baseline + dy - e.cellAscPx / dpr - pad
    q[qb + 2] = e.w / dpr
    q[qb + 3] = e.h / dpr
    q[qb + 4] = e.u0
    q[qb + 5] = e.v0
    q[qb + 6] = e.u1
    q[qb + 7] = e.v1
    q[qb + 8] = color.r
    q[qb + 9] = color.g
    q[qb + 10] = color.b
    q[qb + 11] = color.a * alpha
    q[qb + 12] = colour ? 0 : 1
    q[qb + 13] = this.space
    q[qb + 14] = 0
    q[qb + 15] = 0
    q[qb + 16] = clip[0] ?? -1e9
    q[qb + 17] = clip[1] ?? -1e9
    q[qb + 18] = clip[2] ?? 1e9
    q[qb + 19] = clip[3] ?? 1e9
    q[qb + 20] = xf[0]
    q[qb + 21] = xf[1]
    q[qb + 22] = xf[2]
    q[qb + 23] = xf[3]
    q[qb + 24] = tx + g.offset.x
    q[qb + 25] = ty + g.offset.y
    q[qb + 26] = 0
    q[qb + 27] = 0
    this.atlasLive++
  }

  /**
   * Slug glyph index for a grapheme, or 0 when it must fall back: colour /
   * emoji, a multi-code-point cluster we can't shape (variation selectors
   * aside), or a code point the face has no glyph for. The first two are
   * classified once at read time (`Glyph.colour` / `Glyph.codePoints`).
   */
  private slugGlyph(face: FaceEntry, g: Glyph): number {
    if (g.colour || g.codePoints > 1) {
      return 0
    }
    return this.glyphIndex(face, g.glyphId)
  }

  draw(encoder: GPURenderPassEncoder, first: number, count: number): number {
    if (this.count === 0 || count === 0) {
      return 0
    }
    let draws = 0
    const slug = this.ready && this.slugLive > 0 && this.bindGroup
    const atlas = this.atlasLive > 0 && this.atlasBindGroup
    // Text shadows of these runs first, under every glyph. Blurred (atlas)
    // shadows go before hard (Slug) ones: glows are usually listed last.
    const s0 = this.shadowStart[first] ?? 0
    const s1 = this.shadowStart[first + count] ?? s0
    if (s1 > s0) {
      if (atlas) {
        encoder.setPipeline(this.atlasPipeline)
        encoder.setBindGroup(1, atlas)
        encoder.draw(6, s1 - s0, 0, s0)
        draws++
      }
      if (slug) {
        encoder.setPipeline(this.pipeline)
        encoder.setBindGroup(1, slug)
        encoder.draw(6, s1 - s0, 0, s0)
        draws++
      }
    }
    if (slug) {
      encoder.setPipeline(this.pipeline)
      encoder.setBindGroup(1, slug)
      encoder.draw(6, count, 0, first)
      draws++
    }
    if (atlas) {
      encoder.setPipeline(this.atlasPipeline)
      encoder.setBindGroup(1, atlas)
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

/**
 * Right edge, in `glyphs[j]`'s local frame, of the union of the `len`
 * component rects starting at j, or null when they don't form one ligature
 * on screen: fewer than two, a gap between graphemes, a line break, or a
 * component rect that doesn't abut the previous one. Glyphs in a run share
 * the linear part of their xform, so a component's origin in the first's
 * frame is `inv(lin) · (t_k − t_0)` (as decorations.ts does).
 */
function ligatureRight(
  glyphs: readonly Glyph[],
  j: number,
  len: number
): number | null {
  const g0 = glyphs[j]
  if (!g0 || len < 2) {
    return null
  }
  const [a, b, c, d, tx0, ty0] = g0.xform
  const det = a * d - b * c
  let prevRight = g0.local.w
  let right = prevRight
  for (let k = 1; k < len; k++) {
    const gk = glyphs[j + k]
    if (!gk || gk.index !== g0.index + k) {
      return null
    }
    const dx = gk.xform[4] - tx0
    const dy = gk.xform[5] - ty0
    const ix = det !== 0 ? (d * dx - c * dy) / det : dx
    const iy = det !== 0 ? (a * dy - b * dx) / det : dy
    if (Math.abs(iy) >= 1 || Math.abs(ix - prevRight) > LIGATURE_GAP) {
      return null
    }
    prevRight = ix + gk.local.w
    right = Math.max(right, prevRight)
  }
  return right
}

const NO_SHADOWS: readonly TextShadow[] = []

/** Device-px blur for the shadow atlas key, quantised to 1/2 px. */
function shadowBlurPx(blur: number, dpr: number): number {
  return Math.max(0.5, Math.round(blur * dpr * 2) / 2)
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
