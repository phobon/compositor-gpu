import type { Shared } from '../../gpu/frame'
import type { Scene } from '../../scene/scene'
import { log, reportShaderErrors } from '../../util/log'
import type { TextBackend } from '../textRasterizer'
import { type ParsedFont, parseFont } from './font'
import { SLUG_WGSL } from './shaders'

const GLYPH_FLOATS = 16 // rect(4)+offset(4)+color(4)+gref(4)

/**
 * Slug text backend: atlas-free, outline-based glyph rendering.
 *
 * STATUS: pipeline + instance packing + the CPU font->band pipeline are wired.
 * `loadFontBuffer` builds the band/curve GPU buffers for a set of code points
 * and flips `ready`. Wiring `prepare()` to fetch a FontFace's bytes at runtime,
 * and finishing the analytic-coverage shader, are the remaining v1 tasks.
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
  private codeToGref = new Map<number, { start: number; count: number }>()
  private fonts: ParsedFont[] = []

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
    // v1 TODO: resolve each FontFace to its source bytes (fetch its URL) and
    // call loadFontBuffer. FontFace does not expose parsed bytes, so the
    // compositor is expected to provide font URLs/buffers explicitly for now.
    if (faces.length === 0) log.info('SlugText.prepare: no fonts provided')
  }

  /**
   * Parse a font and build GPU band/curve buffers for the given code points
   * (default: printable ASCII). Flips `ready`.
   */
  loadFontBuffer(
    buffer: ArrayBuffer,
    fontId = 0,
    codePoints: number[] = defaultCodePoints()
  ): void {
    const font = parseFont(buffer, fontId)
    this.fonts.push(font)

    const bandData: number[] = [] // vec4f per band
    const curveData: number[] = [] // 8 floats per curve (vec4 + vec4)

    for (const cp of codePoints) {
      const gi = font.glyphForCodePoint(cp)
      const gb = font.glyph(gi)
      const bandStart = bandData.length / 4
      const curveBase = curveData.length / 8
      for (const band of gb.bands) {
        bandData.push(
          band.yMin,
          band.yMax,
          curveBase + band.start,
          curveBase + band.end
        )
      }
      for (const q of gb.curves) {
        curveData.push(q.x0, q.y0, q.x1, q.y1, q.cx, q.cy, 0, 0)
      }
      this.codeToGref.set(cp, { start: bandStart, count: gb.bands.length })
    }

    const { device } = this.shared
    this.bandBuf?.destroy()
    this.curveBuf?.destroy()
    this.bandBuf = device.createBuffer({
      size: Math.max(16, bandData.length * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.curveBuf = device.createBuffer({
      size: Math.max(32, curveData.length * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    device.queue.writeBuffer(this.bandBuf, 0, new Float32Array(bandData))
    device.queue.writeBuffer(this.curveBuf, 0, new Float32Array(curveData))
    this.ensureGlyphCapacity(256)
    this.rebuildBindGroup()
    this.ready = true
    log.info(
      `SlugText: font ${fontId} — ${bandData.length / 4} bands, ${
        curveData.length / 8
      } curves`
    )
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
    this.count = total
    if (total === 0 || !this.ready) return
    this.ensureGlyphCapacity(total)
    const f = this.glyphF32
    const u = this.glyphU32
    let i = 0
    for (const run of scene.runs) {
      for (const g of run.glyphs) {
        const base = i * GLYPH_FLOATS
        f[base + 0] = g.rect.x
        f[base + 1] = g.rect.y
        f[base + 2] = g.rect.width
        f[base + 3] = g.rect.height
        f[base + 4] = g.offset.x
        f[base + 5] = g.offset.y
        f[base + 6] = 0
        f[base + 7] = 0
        f[base + 8] = g.color.r
        f[base + 9] = g.color.g
        f[base + 10] = g.color.b
        f[base + 11] = g.color.a
        const gref = this.codeToGref.get(g.glyphId)
        u[base + 12] = gref?.start ?? 0
        u[base + 13] = gref?.count ?? 0
        u[base + 14] = 0
        u[base + 15] = 0
        i++
      }
    }
    this.shared.device.queue.writeBuffer(
      this.glyphBuf as GPUBuffer,
      0,
      this.glyphBytes,
      0,
      total * GLYPH_FLOATS * 4
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
