import type { Shared } from '../../gpu/frame'
import { type MaterialBinding, PassPipelines } from '../../gpu/material'
import { quadVerts, SkeletonTwin } from '../../gpu/skeleton'
import { StorageArray } from '../../gpu/storage'
import type { Glyph, GlyphRun, RGBA, TextShadow } from '../../scene/records'
import type { Scene } from '../../scene/scene'
import type { FontDescriptor } from '../../types'
import { log, reportShaderErrors } from '../../util/log'
import { ATLAS_QUAD_FLOATS, ATLAS_WGSL } from '../atlas_shader'
import { describeFace, resolveFontBytes } from '../font_source'
import { ATLAS_PAD, type AtlasEntry, GlyphAtlas } from '../glyp'
import type { TextBackend } from '../text_rasterizer'
import { type BakedFace, type BakedManifest, decodeBakedFont } from './baked'
import {
  type FontHandle,
  type GlyphBands,
  loadFontFile,
  loadParser,
  makeInstance,
  type ParsedFont,
  parserReady,
  type Quad
} from './font'
import { slugBody } from './shaders'

// rect(4)+offset(4)+color(4)+gref(4)+clip(4)+xf0(4)+xf1(4). gref is u32,
// written through the shared u32 view of the same buffer.
export const GLYPH_FLOATS = 28

/** The Slug instance and outline buffers, for drawing mirrored glyphs
 * elsewhere (`/fx` Layers). Instance layout: the `Glyph` struct in
 * shaders.ts. */
export interface GlyphTable {
  glyphs: GPUBuffer
  bands: GPUBuffer
  curves: GPUBuffer
  /** Instance index of `run`'s first glyph in the last upload. */
  start(run: GlyphRun): number | undefined
}

/**
 * A copy of some glyphs' Slug instances as last packed, with their bands
 * held resident (pinned against LRU eviction) until `release()`: a
 * morph draws the outgoing text from it after the DOM has changed
 * (fx/morph.ts). Instance i is glyph i of the runs asked for, in order.
 */
export interface GlyphGhost {
  count: number
  /** GLYPH_FLOATS per glyph: the `Glyph` struct (shaders.ts); gref is u32
   * in the same bytes. A glyph Slug doesn't draw has gref.y 0. */
  instances: Float32Array
  /** Per glyph: its outline in drawing order, normalised to its tight
   * bbox, y-up (font.ts `GlyphBands.outline`); null when Slug doesn't
   * draw it. */
  outlines: (Quad[] | null)[]
  /** The grapheme per glyph. */
  text: string[]
  /** Unpin the bands (idempotent). */
  release(): void
}
/** Max gap (px) between a component's right edge and the next one's left
 * edge for them to count as one ligature: Chrome's split rects abut. */
const LIGATURE_GAP = 1.5
/** tan(14°): the browser's synthetic-oblique shear. */
const OBLIQUE = Math.tan((14 * Math.PI) / 180)
const BAND_COUNT = 16 // bands per direction — must match font.ts
/** Row bands then column bands per resident glyph. */
const BANDS_PER_SLOT = 2 * BAND_COUNT
const CURVE_FLOATS = 8 // vec4 p + vec4 c

// Resident-glyph cache geometry. Each glyph occupies one fixed-size slot: 16
// row + 16 column bands and up to MAX_CURVES banded curves (both directions,
// so about twice the outline's). Fixed stride means O(1) eviction and no
// fragmentation, at the cost of space for simple glyphs (32 MB of curves)
// and a curve budget that skips pathologically complex glyphs. All three are
// safe to tune.
const SLOT_COUNT = 1024
const MAX_CURVES = 1024

type BBox = { x1: number; y1: number; x2: number; y2: number }

interface FaceEntry {
  idx: number
  family: string
  weight: number
  italic: boolean
  font: ParsedFont
  /** A baked face (M5f): matched only by bakedFor, never as a nearest
   * static weight. */
  baked?: BakedFace
}

/** A manifest's face with its file's absolute URL. */
type BakedSpec = BakedFace & { href: string }

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
  /** Up to 12 distinct fallback graphemes from the last upload, as
   * `"text" family weight reason`, for `stats().fallbackSamples`. */
  fallbackSamples = new Set<string>()
  /** Ligature glyphs formed in the last upload (components merged). */
  ligatureCount = 0
  /** `"family weight[i]"` labels of faces `prepare()` couldn't resolve (no
   * matching @font-face src, or its url() didn't fetch). Runs using them
   * fall back to the Canvas 2D atlas. */
  readonly failedFaces: string[] = []

  private readonly pipelines: PassPipelines
  private layout: GPUBindGroupLayout
  /** One instance per glyph (Slug), and one fallback-atlas quad per
   * glyph in the same index space (zero in the one that doesn't draw
   * it), so draw(first, count) is valid for both. */
  private readonly glyphs: StorageArray
  private readonly quads: StorageArray
  private readonly bandBuf: GPUBuffer
  private readonly curveBuf: GPUBuffer
  private bindGroup: GPUBindGroup | null = null
  private count = 0

  // Fallback atlas quads: a second pipeline sharing the glyph index space.
  // Every glyph writes one instance into each buffer (zero-rect in the one
  // that doesn't draw it), so draw(first, count) is valid for both.
  private readonly atlas = new GlyphAtlas()
  private atlasPipeline: SkeletonTwin
  private atlasLayout: GPUBindGroupLayout
  /** Atlas pipelines with a material's blend state (the built-in
   * `mix-blend-mode` materials), by material id; built on first use. */
  private readonly atlasBlended = new Map<number, SkeletonTwin>()
  private readonly makeAtlasPipeline: (blend: GPUBlendState) => SkeletonTwin
  private readonly atlasSampler: GPUSampler
  private atlasBindGroup: GPUBindGroup | null = null
  private atlasGen = -1
  private slugLive = 0
  /** Non-zero atlas quads (fallback glyphs + atlas-drawn text shadows). */
  private atlasLive = 0
  /** Glyphs + text-shadow instances written by the last upload. */
  private instances = 0
  /** Per glyph index: start of its run's shadow range (see fill). */
  private shadowStart = new Uint32Array(0)
  /** Instance index of each run's first glyph (glyphTable). */
  private runStarts = new Map<GlyphRun, number>()
  /** The current run's doc-space clip (minX, minY, maxX, maxY). */
  private readonly clip = new Float64Array(4)
  /** The current run's space flag (1 = viewport, see frame.ts to_clip). */
  private space = 0
  /** The current run's clip shape index (Scene.clipIndex; 0 none). */
  private clipShape = 0
  // face.idx * 2^21 + code point -> glyph index (0 = .notdef).
  private gidCache = new Map<number, number>()
  // Per-run Slug glyph ids (0 = fallback), reused across runs.
  private idScratch: number[] = []

  private faces: FaceEntry[] = []
  private loadedKeys = new Set<string>()
  /** Face keys prepare() is fetching. */
  private preparing = new Set<string>()
  /** Buffers handed to loadFontBuffer before opentype.js had loaded. */
  private queued = 0
  /** Called when a face is registered after a deferred parse (the
   * compositor re-reads styles then). */
  onFace: (() => void) | null = null

  /** Fonts handed to loadFontBuffer still waiting for the parser, or
   * baked files (and the faces they fall back to) still loading. */
  get facesPending(): boolean {
    return this.queued > 0
  }

  // Baked assets (useAssets): the manifest's faces, the files loaded or
  // loading, and the FontFaces whose sources prepare() didn't fetch
  // because their family is baked (the runtime fallback's input).
  private assets: BakedSpec[] | null = null
  private assetsLoad: Promise<void> | null = null
  private bakedLoading = new Map<string, Promise<void>>()
  /** Baked files done loading (registered or failed). */
  private bakedSettled = new Set<string>()
  private bakedSkipped = new Map<string, FontFace[]>()
  private bakedFellBack = new Set<string>()

  /**
   * Draw the families a baked-asset manifest lists from its files
   * (tools/bake.ts): prepare() fetches those instead of the @font-face
   * sources. Call before the first prepare().
   */
  useAssets(url: string): void {
    const href = new URL(url, document.baseURI).href
    this.queued++
    this.assetsLoad = fetch(href)
      .then((r) =>
        r.ok
          ? (r.json() as Promise<BakedManifest>)
          : Promise.reject(new Error(`${r.status} ${r.statusText}`))
      )
      .then((m) => {
        this.assets = (m.fonts ?? []).map((f) => ({
          ...f,
          href: new URL(f.url, href).href
        }))
        log.info(`SlugText: ${this.assets.length} baked face(s) in ${url}`)
      })
      .catch((err: unknown) => {
        log.info(
          `SlugText: no baked assets from ${url} (${(err as Error).message}); parsing fonts at runtime`
        )
        this.assets = []
      })
      .finally(() => {
        this.queued--
      })
  }

  /** The manifest's faces of a family and slant. */
  private bakedSpecs(family: string, italic: boolean): BakedSpec[] {
    const fam = family.toLowerCase()
    return (this.assets ?? []).filter(
      (f) => f.family.toLowerCase() === fam && f.italic === italic
    )
  }

  /** Fetch and register one baked file (once). */
  private loadBaked(spec: BakedSpec): Promise<void> {
    let p = this.bakedLoading.get(spec.href)
    if (p) {
      return p
    }
    this.queued++
    p = fetch(spec.href)
      .then((r) =>
        r.ok
          ? r.arrayBuffer()
          : Promise.reject(new Error(`${r.status} ${r.statusText}`))
      )
      .then((buf) => {
        const idx = this.faces.length
        this.faces.push({
          idx,
          family: spec.family.toLowerCase(),
          weight: spec.weight,
          italic: spec.italic,
          font: decodeBakedFont(buf, idx),
          baked: spec
        })
        this.ready = true
        this.resolveCache.clear()
        log.info(
          `SlugText: +baked ${spec.family} ${spec.weight}${
            spec.italic ? 'i' : ''
          }${spec.opsz === null ? '' : ` opsz ${spec.opsz}`}`
        )
      })
      .catch((err: unknown) => {
        log.info(
          `SlugText: could not load baked ${spec.url} — ${(err as Error).message}`
        )
      })
      .finally(() => {
        this.bakedSettled.add(spec.href)
        this.queued--
      })
    this.bakedLoading.set(spec.href, p)
    return p
  }

  /** The baked face for a run, null when its family has none loaded that
   * matches (weight clamped to the source's wght range, or the nearest
   * static weight; opsz exact, or the axis default without one). */
  private bakedFor(
    fam: string,
    weight: number,
    italic: boolean,
    opsz: number | null
  ): FaceEntry | null {
    const pool = this.faces.filter(
      (f) => f.baked && f.family === fam && f.italic === italic
    )
    let best: FaceEntry | null = null
    let bestDiff = Number.POSITIVE_INFINITY
    for (const f of pool) {
      const b = f.baked as BakedFace
      const w = b.wghtRange
        ? Math.max(b.wghtRange[0], Math.min(b.wghtRange[1], weight))
        : weight
      if (b.opsz !== null) {
        const want =
          opsz === null || !b.opszRange
            ? b.opszDefault
            : Math.max(b.opszRange[0], Math.min(b.opszRange[1], opsz))
        if (want !== b.opsz) {
          continue
        }
      }
      if (b.wghtRange) {
        if (w === b.weight) {
          return f
        }
        continue
      }
      const d = Math.abs(b.weight - w)
      if (d < bestDiff) {
        best = f
        bestDiff = d
      }
    }
    return best
  }

  /** A run of a baked family the manifest doesn't cover: load the
   * family's @font-face sources after all (once). */
  private fallBack(fam: string, italic: boolean): void {
    const key = `${fam}|${italic ? 1 : 0}`
    if (this.bakedFellBack.has(key)) {
      return
    }
    this.bakedFellBack.add(key)
    const faces = this.bakedSkipped.get(key) ?? []
    if (faces.length === 0) {
      return
    }
    log.info(
      `SlugText: ${fam} needs a weight or size the baked files lack; parsing its source`
    )
    this.queued++
    void this.prepare(faces, true)
      .then(() => this.onFace?.())
      .finally(() => {
        this.queued--
      })
  }
  private resolveCache = new Map<string, FaceEntry | null>()
  // Variable fonts are kept as sources and instanced to exact weights on
  // demand, so one file backs every weight the page uses.
  private variableSources: {
    family: string
    italic: boolean
    handle: FontHandle
    min: number
    max: number
    opsz?: { min: number; max: number }
  }[] = []
  private instanced = new Map<string, FaceEntry>()

  // Resident-glyph LRU. `cache` maps a glyph key to its slot; Map insertion
  // order is the recency order (oldest first), so the LRU victim is the first
  // key. `slotFrame` pins slots touched in the current upload.
  private cache = new Map<number, number>()
  private slotBBox: BBox[] = new Array(SLOT_COUNT)
  private slotFrame = new Int32Array(SLOT_COUNT)
  /** Ghosts holding each slot (GlyphGhost): never evicted while > 0. */
  private slotPins = new Uint16Array(SLOT_COUNT)
  /** What each slot holds (its outline, for ghosts). */
  private slotGlyph: (GlyphBands | undefined)[] = new Array(SLOT_COUNT)
  private nextFree = 0
  private frameId = 0
  /** Slots reassigned to another glyph so far (see patchRuns). */
  private evictions = 0
  /** dpr of the last full pack (instances bake device-px snapping). */
  private packedDpr = 0
  private overflowed = false
  private warnedBudget = false
  /** Glyph keys refused for exceeding MAX_CURVES (drawn via the atlas). */
  private readonly refused = new Set<number>()
  private readonly bandScratch = new Float32Array(BANDS_PER_SLOT * 4)
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
    this.pipelines = new PassPipelines(shared, {
      kind: 'glyph',
      label: 'slug',
      layout: this.layout,
      body: slugBody
    })
    this.glyphs = new StorageArray(device, GLYPH_FLOATS, 256)
    this.quads = new StorageArray(device, ATLAS_QUAD_FLOATS, 256)

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
    const atlasLayout = device.createPipelineLayout({
      bindGroupLayouts: [frameLayout, this.atlasLayout]
    })
    this.makeAtlasPipeline = (blend) =>
      new SkeletonTwin(device, {
        layout: atlasLayout,
        vertex: { module: atlasModule, entryPoint: 'vs' },
        fragment: {
          module: atlasModule,
          entryPoint: 'fs',
          targets: [{ format, blend }]
        },
        primitive: { topology: 'triangle-list' }
      })
    this.atlasPipeline = this.makeAtlasPipeline({
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
    })

    this.bandBuf = device.createBuffer({
      size: SLOT_COUNT * BANDS_PER_SLOT * 16,
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
  async prepare(faces: FontFace[], skipBaked = false): Promise<void> {
    if (faces.length === 0) {
      log.info('SlugText.prepare: no fonts provided')
      return
    }
    if (!skipBaked && this.assetsLoad) {
      await this.assetsLoad
      // Faces of baked families: their baked files, not their sources.
      const baked: Promise<void>[] = []
      faces = faces.filter((f) => {
        const d = describeFace(f)
        const specs = this.bakedSpecs(d.family, d.italic)
        if (specs.length === 0) {
          return true
        }
        const key = `${d.family.toLowerCase()}|${d.italic ? 1 : 0}`
        const list = this.bakedSkipped.get(key) ?? []
        list.push(f)
        this.bakedSkipped.set(key, list)
        for (const s of specs) {
          baked.push(this.loadBaked(s))
        }
        return false
      })
      await Promise.all(baked)
      if (faces.length === 0) {
        return
      }
    }
    // Faces registered or being fetched (a face reported again on
    // loadingdone) aren't fetched twice.
    const keys = new Set<string>()
    const todo = faces.filter((f) => {
      const key = faceKey(describeFace(f))
      if (this.loadedKeys.has(key) || this.preparing.has(key)) {
        return false
      }
      keys.add(key)
      return true
    })
    if (todo.length === 0) {
      return
    }
    for (const key of keys) {
      this.preparing.add(key)
    }
    let result: Awaited<ReturnType<typeof resolveFontBytes>>
    try {
      ;[result] = await Promise.all([resolveFontBytes(todo), loadParser()])
    } finally {
      for (const key of keys) {
        this.preparing.delete(key)
      }
    }
    const { resolved, failed } = result
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
   * Before opentype.js has loaded (a dynamic import) the face registers
   * once it has, then `onFace` runs.
   */
  loadFontBuffer(buffer: ArrayBuffer, descriptor: FontDescriptor = {}): void {
    if (!parserReady()) {
      // opentype.js loads by dynamic import: register once it has.
      this.queued++
      void loadParser()
        .then(() => {
          this.loadFontBuffer(buffer, descriptor)
          this.onFace?.()
        })
        .catch((err: unknown) => {
          log.error('SlugText: could not load opentype.js', err)
        })
        .finally(() => {
          this.queued--
        })
      return
    }
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
        max: handle.wght.max,
        opsz: handle.opsz
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
    italic: boolean,
    opsz: number | null
  ): FaceEntry | null {
    if (this.faces.length === 0 && this.variableSources.length === 0) {
      return null
    }
    const o = opsz === null ? null : Math.round(opsz)
    const key = `${family}|${weight}|${italic ? 1 : 0}|${o}`
    const cached = this.resolveCache.get(key)
    if (cached !== undefined) {
      return cached
    }

    const fam = family.toLowerCase()
    // A baked face first (M5f); a baked family the files don't cover
    // loads its source (this run uses the atlas until then).
    if (this.assets?.length) {
      const baked = this.bakedFor(fam, weight, italic, o)
      if (baked) {
        this.resolveCache.set(key, baked)
        return baked
      }
      const specs = this.bakedSpecs(fam, italic)
      if (specs.length > 0) {
        if (specs.every((s) => this.bakedSettled.has(s.href))) {
          this.fallBack(fam, italic)
        } else {
          // Still loading: the atlas meanwhile, resolved again after.
          return null
        }
      }
    }
    // Prefer a family-matching variable font (exact weight), then a static
    // face; faces registered without a family ('') match any run. A run
    // whose family has no face returns null and falls back to the atlas.
    const best =
      this.instanceFor(fam, weight, italic, o) ??
      this.bestStatic(fam, weight, italic) ??
      this.instanceFor('', weight, italic, o) ??
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
    let pool = this.faces.filter((f) => f.family === fam && !f.baked)
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
   * Instance a variable source at (clamped) `weight` and, when the font has
   * an `opsz` axis and the run asks for one, (clamped, whole-px) optical
   * size — the browser's `font-optical-sizing: auto` picks opsz = font-size,
   * so a 96px heading and 16px body text come from different instances.
   * One face is cached per distinct (weight, opsz). Returns null if no
   * variable source of `fam` qualifies.
   */
  private instanceFor(
    fam: string,
    weight: number,
    italic: boolean,
    opsz: number | null
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
    const o =
      src.opsz && opsz !== null
        ? Math.max(src.opsz.min, Math.min(src.opsz.max, opsz))
        : null
    const instKey = `${src.family}|${w}|${italic ? 1 : 0}|${o}`
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
      font: makeInstance(
        src.handle,
        idx,
        o === null ? { wght: w } : { wght: w, opsz: o }
      )
    }
    this.faces.push(face)
    this.instanced.set(instKey, face)
    log.info(
      `SlugText: instanced ${src.family || '(any)'} @ wght ${w}${
        o === null ? '' : ` opsz ${o}`
      }`
    )
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
      // The least recently used slot no ghost holds.
      let oldestKey: number | undefined
      for (const [k, s] of this.cache) {
        if ((this.slotPins[s] ?? 0) === 0) {
          oldestKey = k
          break
        }
      }
      if (oldestKey === undefined) {
        this.overflowed = true // every slot is held by a ghost
        return -1
      }
      const victim = this.cache.get(oldestKey) as number
      if (this.slotFrame[victim] === this.frameId) {
        this.overflowed = true // every slot is pinned by this frame
        return -1
      }
      this.cache.delete(oldestKey)
      this.evictions++
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
    this.slotGlyph[slot] = gb
    const curveBase = slot * MAX_CURVES
    const b = this.bandScratch
    for (let i = 0; i < BANDS_PER_SLOT; i++) {
      const band = i < BAND_COUNT ? gb.bands[i] : gb.vbands[i - BAND_COUNT]
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
      slot * BANDS_PER_SLOT * 16,
      b.buffer,
      0,
      BANDS_PER_SLOT * 16
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
    if (!this.glyphs.ensure(n)) {
      return
    }
    this.quads.ensure(n)
    this.rebuildBindGroup()
    this.atlasBindGroup = null
  }

  /**
   * Copy `runs`' glyph instances as last packed and pin their bands until
   * the ghost is released (see GlyphGhost). Null when a run wasn't in the
   * last upload.
   */
  ghost(runs: readonly GlyphRun[]): GlyphGhost | null {
    let count = 0
    for (const run of runs) {
      if (this.runStarts.get(run) === undefined) {
        return null
      }
      count += run.glyphs.length
    }
    const instances = new Float32Array(count * GLYPH_FLOATS)
    const outlines: (Quad[] | null)[] = []
    const text: string[] = []
    const slots: number[] = []
    const f = this.glyphs.f32
    const u = this.glyphs.u32
    let k = 0
    for (const run of runs) {
      const first = this.runStarts.get(run) ?? 0
      for (let i = 0; i < run.glyphs.length; i++, k++) {
        const base = (first + i) * GLYPH_FLOATS
        instances.set(f.subarray(base, base + GLYPH_FLOATS), k * GLYPH_FLOATS)
        const bands = u[base + 13] ?? 0
        const slot = Math.floor((u[base + 12] ?? 0) / BANDS_PER_SLOT)
        if (bands > 0 && slot < SLOT_COUNT) {
          this.slotPins[slot] = (this.slotPins[slot] ?? 0) + 1
          slots.push(slot)
          outlines.push(this.slotGlyph[slot]?.outline ?? null)
        } else {
          outlines.push(null)
        }
        text.push(run.glyphs[i]?.text ?? '')
      }
    }
    let held = true
    return {
      count,
      instances,
      outlines,
      text,
      release: () => {
        if (!held) {
          return
        }
        held = false
        for (const slot of slots) {
          this.slotPins[slot] = Math.max(0, (this.slotPins[slot] ?? 0) - 1)
        }
      }
    }
  }

  /** The instance and outline buffers (null before the first glyph). */
  glyphTable(): GlyphTable | null {
    if (!this.glyphs.buffer || this.slugLive === 0) {
      return null
    }
    return {
      glyphs: this.glyphs.buffer,
      bands: this.bandBuf,
      curves: this.curveBuf,
      start: (run) => this.runStarts.get(run)
    }
  }

  private rebuildBindGroup(): void {
    if (!this.glyphs.buffer) {
      return
    }
    this.bindGroup = this.shared.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.glyphs.buffer } },
        { binding: 1, resource: { buffer: this.bandBuf } },
        { binding: 2, resource: { buffer: this.curveBuf } }
      ]
    })
  }

  /** Rebuild the atlas bind group if the quad buffer or texture changed. */
  private ensureAtlasBindGroup(): void {
    const view = this.atlas.view
    if (!this.quads.buffer || !view) {
      return
    }
    if (this.atlasBindGroup && this.atlasGen === this.atlas.generation) {
      return
    }
    this.atlasBindGroup = this.shared.device.createBindGroup({
      layout: this.atlasLayout,
      entries: [
        { binding: 0, resource: { buffer: this.quads.buffer } },
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
    const patch = scene.textPatch
    if (patch && this.patchRuns(scene, patch)) {
      return
    }
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
    this.runStarts.clear()
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
    this.packedDpr = dpr
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
    if (this.slugLive > 0) {
      this.glyphs.write(0, m)
    }
    if (this.atlasLive > 0) {
      this.atlas.flush(this.shared.device)
      this.ensureAtlasBindGroup()
      this.quads.write(0, m)
    }
  }

  /**
   * Re-pack only the runs a scene patch replaced (Scene.replace), each
   * into its old run's instance ranges (same glyph and shadow counts), and
   * upload just those ranges. False, for a full pack, when a run isn't
   * known, the dpr changed, or packing evicted a glyph slot, reset the
   * atlas or made a pipeline live that wasn't (the instances not re-packed
   * would then be stale). Stats (fallbacks, ligatures) keep the last full
   * pack's values.
   */
  private patchRuns(
    scene: Scene,
    patch: readonly (readonly [GlyphRun, GlyphRun])[]
  ): boolean {
    const dpr = this.shared.dpr > 0 ? this.shared.dpr : 1
    if (this.count === 0 || dpr !== this.packedDpr) {
      return false
    }
    const ranges: [GlyphRun, GlyphRun, number, number][] = []
    for (const [a, b] of patch) {
      const first = this.runStarts.get(a)
      if (first === undefined || a.glyphs.length !== b.glyphs.length) {
        return false
      }
      ranges.push([a, b, first, this.shadowStart[first] ?? 0])
    }
    const evictions = this.evictions
    const epoch = this.atlas.epoch
    const slugBefore = this.slugLive > 0
    const atlasBefore = this.atlasLive > 0
    const stats = [this.fallbackCount, this.ligatureCount] as const
    this.frameId++
    this.overflowed = false
    for (const [a, b, first, runBase] of ranges) {
      this.runStarts.delete(a)
      this.runStarts.set(b, first)
      if (b.glyphs.length > 0) {
        this.fillRun(scene, b, first, runBase, dpr)
      }
    }
    ;[this.fallbackCount, this.ligatureCount] = stats
    if (
      this.evictions !== evictions ||
      this.atlas.epoch !== epoch ||
      this.overflowed ||
      (!slugBefore && this.slugLive > 0) ||
      (!atlasBefore && this.atlasLive > 0)
    ) {
      return false
    }
    if (atlasBefore) {
      this.atlas.flush(this.shared.device)
      this.ensureAtlasBindGroup()
    }
    for (const [, b, first, runBase] of ranges) {
      const n = b.glyphs.length
      const shadows = (b.textShadows?.length ?? 0) * n
      if (slugBefore) {
        this.glyphs.write(first, n)
        this.glyphs.write(runBase, shadows)
      }
      if (atlasBefore) {
        this.quads.write(first, n)
        this.quads.write(runBase, shadows)
      }
    }
    return true
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
    this.slugLive = 0
    this.atlasLive = 0
    this.fallbackCount = 0
    this.fallbackSamples.clear()
    this.ligatureCount = 0
    let i = 0
    let sCursor = total
    for (const run of scene.runs) {
      this.runStarts.set(run, i)
      this.fillRun(scene, run, i, sCursor, dpr)
      i += run.glyphs.length
      sCursor += (run.textShadows?.length ?? 0) * run.glyphs.length
    }
    this.shadowStart[i] = sCursor
    return i
  }

  /** Write `run`'s glyphs from instance `first` and its shadows from
   * `runBase` (see fill). */
  private fillRun(
    scene: Scene,
    run: GlyphRun,
    first: number,
    runBase: number,
    dpr: number
  ): void {
    const f = this.glyphs.f32
    const u = this.glyphs.u32
    const q = this.quads.f32
    const pad = ATLAS_PAD / dpr
    const starts = this.shadowStart
    const ids = this.idScratch
    let i = first
    const face = this.resolveFace(
      run.fontFamily,
      run.fontWeight,
      run.italic,
      run.opsz
    )
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
    this.clipShape = scene.clipIndex(cl)
    const alpha = run.opacity
    // Italic requested but the face is upright: synthesise oblique like
    // the browser does (a shear about the baseline; Slug only — the atlas
    // rasterises with `italic` in the font string, so Canvas 2D does it).
    const oblique = face && run.italic && !face.italic ? OBLIQUE : 0
    const glyphs = run.glyphs
    const nGlyphs = glyphs.length
    const shadows = run.textShadows ?? NO_SHADOWS
    const S = shadows.length
    const runEnd = runBase + S * nGlyphs
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
      starts[i] = j === 0 ? runBase : runEnd
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
        // Blink rounds a font's ascent and descent to whole CSS px before
        // laying out the line box (SimpleFontData), so the baseline sits
        // at lineTop + halfLeading + round(ascent).
        const asc = Math.round(ascPx * F)
        const desc = Math.round(descPx * F)
        const halfLead = (g.local.h - (asc + desc)) / 2
        let baseline = halfLead + asc
        // Browsers position glyphs at whole device pixels vertically
        // (sub-pixel only in x), which is what keeps baselines, x-heights
        // and crossbars crisp at small sizes. Match that for untransformed
        // runs; a transformed run keeps its exact baseline.
        if (xf[0] === 1 && xf[1] === 0 && xf[2] === 0 && xf[3] === 1) {
          const ty = xf[5]
          baseline = Math.round((ty + baseline) * dpr) / dpr - ty
        }
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
        f[base + 7] = this.clipShape
        f[base + 8] = g.color.r
        f[base + 9] = g.color.g
        f[base + 10] = g.color.b
        f[base + 11] = g.color.a * alpha
        u[base + 12] = slot >= 0 ? slot * BANDS_PER_SLOT : 0
        u[base + 13] = slot >= 0 ? BAND_COUNT : 0
        // The glyph's index in its material's target (mat_index).
        u[base + 14] = (run.glyphBase ?? 0) + j
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
        if (this.fallbackSamples.size < 12) {
          this.fallbackSamples.add(
            `${JSON.stringify(g.text)} ${run.fontFamily} ${run.fontWeight} ${
              face ? 'no-glyph' : 'no-face'
            }`
          )
        }
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

  /** Zero both pipelines' instance `k`. */
  private zeroInstance(k: number): void {
    this.glyphs.f32.fill(0, k * GLYPH_FLOATS, (k + 1) * GLYPH_FLOATS)
    this.quads.f32.fill(0, k * ATLAS_QUAD_FLOATS, (k + 1) * ATLAS_QUAD_FLOATS)
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
    const q = this.quads.f32
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
    q[qb + 14] = this.clipShape
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

  draw(
    encoder: GPURenderPassEncoder,
    first: number,
    count: number,
    material?: MaterialBinding | null
  ): number {
    if (this.count === 0 || count === 0) {
      return 0
    }
    // A material re-shades the Slug glyphs (and their hard shadows); atlas
    // (fallback) glyphs keep the default pipeline, with the material's
    // blend state (`mix-blend-mode`) when it has one.
    let atlasTwin = this.atlasPipeline
    if (material?.blend) {
      let p = this.atlasBlended.get(material.id)
      if (!p) {
        p = this.makeAtlasPipeline(material.blend)
        this.atlasBlended.set(material.id, p)
      }
      atlasTwin = p
    }
    const skeleton = this.shared.skeleton
    const atlasPipeline = atlasTwin.get(skeleton)
    const quad = quadVerts(skeleton)
    const chosen = this.pipelines.pipelineFor(material)
    if (!chosen) {
      return 0
    }
    const verts = chosen.verts
    const useSlug = (): void => {
      encoder.setPipeline(chosen.pipeline)
      if (chosen.material) {
        encoder.setBindGroup(2, chosen.material.bindGroup)
      }
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
        encoder.setPipeline(atlasPipeline)
        encoder.setBindGroup(1, atlas)
        encoder.draw(quad, s1 - s0, 0, s0)
        draws++
      }
      if (slug) {
        useSlug()
        encoder.setBindGroup(1, slug)
        encoder.draw(verts, s1 - s0, 0, s0)
        draws++
      }
    }
    if (slug) {
      useSlug()
      encoder.setBindGroup(1, slug)
      encoder.draw(verts, count, 0, first)
      draws++
    }
    if (atlas) {
      encoder.setPipeline(atlasPipeline)
      encoder.setBindGroup(1, atlas)
      encoder.draw(quad, count, 0, first)
      draws++
    }
    return draws
  }

  dropMaterial(id: number): void {
    this.pipelines.drop(id)
    this.atlasBlended.delete(id)
  }

  warmMaterial(mat: MaterialBinding): void {
    this.pipelines.warm(mat)
  }

  destroy(): void {
    this.glyphs.destroy()
    this.quads.destroy()
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
