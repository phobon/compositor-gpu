import type { Shared } from '../../gpu/frame'
import type { Scene } from '../../scene/scene'
import type { FontDescriptor } from '../../types'
import { log, reportShaderErrors } from '../../util/log'
import type { TextBackend } from '../textRasterizer'
import { parseFont } from './font'
import { SLUG_WGSL } from './shaders'

const GLYPH_FLOATS = 16 // rect(4)+offset(4)+color(4)+gref(4)

type BBox = { x1: number; y1: number; x2: number; y2: number }
type Gref = { start: number; count: number; bbox: BBox }

interface FaceEntry {
  family: string
  weight: number
  italic: boolean
  ascender: number
  descender: number
  codeToGref: Map<number, Gref>
}

/**
 * Slug text backend: atlas-free, outline-based glyph rendering.
 *
 * Holds a registry of faces keyed by (family, weight, italic). Each run is
 * resolved to its best-matching face at upload time, so a bold heading mirrors
 * as bold. Bands/curves for every face are concatenated into one pair of
 * storage buffers; a glyph's `gref` indexes into that global band table.
 *
 * Fonts are supplied as bytes (FontFace doesn't expose its parsed bytes). The
 * WGSL is validated in the playground — WebGPU can't run headless.
 */
export class SlugText implements TextBackend {
  readonly name = 'slug'
  readonly layer = 'text' as const
  ready = false

  private pipeline: GPURenderPipeline
  private layout: GPUBindGroupLayout
  private glyphBuf: GPUBuffer | null = null
  private bandBuf: GPUBuffer | null = null
  private curveBuf: GPUBuffer | null = null
  private bindGroup: GPUBindGroup | null = null
  private glyphCapacity = 0
  private count = 0
  private glyphBytes = new ArrayBuffer(0)
  private glyphF32 = new Float32Array(0)
  private glyphU32 = new Uint32Array(0)

  private faces: FaceEntry[] = []
  private bandData: number[] = [] // vec4f per band, all faces concatenated
  private curveData: number[] = [] // 8 floats per curve
  private resolveCache = new Map<string, FaceEntry | null>()

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
  }

  async prepare(faces: FontFace[]): Promise<void> {
    // FontFace doesn't expose its parsed bytes; callers use loadFontBuffer.
    if (faces.length === 0) log.info('SlugText.prepare: no fonts provided')
  }

  /**
   * Parse a font and append its glyph band/curve data, tagged with a descriptor
   * (family/weight/italic) used for per-run resolution. Rebuilds GPU buffers.
   */
  loadFontBuffer(
    buffer: ArrayBuffer,
    descriptor: FontDescriptor = {},
    codePoints: number[] = defaultCodePoints()
  ): void {
    const font = parseFont(buffer, this.faces.length)
    const codeToGref = new Map<number, Gref>()

    for (const cp of codePoints) {
      const gi = font.glyphForCodePoint(cp)
      const gb = font.glyph(gi)
      const bandStart = this.bandData.length / 4
      const curveBase = this.curveData.length / 8
      for (const band of gb.bands) {
        this.bandData.push(
          band.yMin,
          band.yMax,
          curveBase + band.start,
          curveBase + band.end
        )
      }
      for (const q of gb.curves) {
        this.curveData.push(q.x0, q.y0, q.x1, q.y1, q.cx, q.cy, 0, 0)
      }
      codeToGref.set(cp, {
        start: bandStart,
        count: gb.bands.length,
        bbox: gb.bbox
      })
    }

    this.faces.push({
      family: (descriptor.family ?? '').toLowerCase(),
      weight: descriptor.weight ?? 400,
      italic: descriptor.italic ?? false,
      ascender: font.ascender,
      descender: font.descender,
      codeToGref
    })
    this.resolveCache.clear()

    const { device } = this.shared
    this.bandBuf?.destroy()
    this.curveBuf?.destroy()
    this.bandBuf = device.createBuffer({
      size: Math.max(16, this.bandData.length * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.curveBuf = device.createBuffer({
      size: Math.max(32, this.curveData.length * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    device.queue.writeBuffer(this.bandBuf, 0, new Float32Array(this.bandData))
    device.queue.writeBuffer(this.curveBuf, 0, new Float32Array(this.curveData))
    this.ensureGlyphCapacity(256)
    this.rebuildBindGroup()
    this.ready = true
    log.info(
      `SlugText: +face ${descriptor.family ?? '(any)'} ${
        descriptor.weight ?? 400
      }${descriptor.italic ? 'i' : ''} — ${this.faces.length} face(s), ${
        this.curveData.length / 8
      } curves`
    )
  }

  /** Best-matching face for a run: family, then italic, then nearest weight. */
  private resolveFace(
    family: string,
    weight: number,
    italic: boolean
  ): FaceEntry | null {
    if (this.faces.length === 0) return null
    const key = `${family}|${weight}|${italic ? 1 : 0}`
    const cached = this.resolveCache.get(key)
    if (cached !== undefined) return cached

    const fam = family.toLowerCase()
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
    this.resolveCache.set(key, best)
    return best
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
    if (!this.glyphBuf || !this.bandBuf || !this.curveBuf) return
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
    const f = this.glyphF32
    const u = this.glyphU32
    let i = 0
    for (const run of scene.runs) {
      const face = this.resolveFace(run.fontFamily, run.fontWeight, run.italic)
      if (!face) continue
      const ascender = face.ascender
      const descender = face.descender
      for (const g of run.glyphs) {
        const gref = face.codeToGref.get(g.glyphId)
        const F = g.fontSize
        const ascPx = ascender * F
        const descPx = -descender * F
        const halfLead = (g.rect.height - (ascPx + descPx)) / 2
        const baseline = g.rect.y + halfLead + ascPx
        const bb = gref?.bbox
        const base = i * GLYPH_FLOATS
        if (bb) {
          f[base + 0] = g.rect.x + bb.x1 * F
          f[base + 1] = baseline - bb.y2 * F
          f[base + 2] = (bb.x2 - bb.x1) * F
          f[base + 3] = (bb.y2 - bb.y1) * F
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
        f[base + 11] = g.color.a
        u[base + 12] = gref?.start ?? 0
        u[base + 13] = gref?.count ?? 0
        u[base + 14] = 0
        u[base + 15] = 0
        i++
      }
    }
    this.count = i
    if (i === 0) return
    this.shared.device.queue.writeBuffer(
      this.glyphBuf as GPUBuffer,
      0,
      this.glyphBytes,
      0,
      i * GLYPH_FLOATS * 4
    )
  }

  draw(encoder: GPURenderPassEncoder): void {
    if (!this.ready || this.count === 0 || !this.bindGroup) return
    encoder.setPipeline(this.pipeline)
    encoder.setBindGroup(1, this.bindGroup)
    encoder.draw(6, this.count)
  }

  destroy(): void {
    this.glyphBuf?.destroy()
    this.bandBuf?.destroy()
    this.curveBuf?.destroy()
  }
}

function defaultCodePoints(): number[] {
  const cps: number[] = []
  for (let c = 0x20; c <= 0x7e; c++) cps.push(c)
  return cps
}
