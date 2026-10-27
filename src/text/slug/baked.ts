import type { GlyphBands, Ligature, ParsedFont, Quad } from './font'

// Baked fonts (M5f; docs/EFFECTS.md, Bake CLI): one font instance (family,
// weight, style, optical size) as a binary the runtime reads without
// opentype.js: metrics, the cmap and default ligatures for the baked
// unicode ranges, and each glyph's outline with its Slug band lists, so
// the GlyphBands the runtime builds from it equal what parsing the font
// would give, bit for bit (test/unit/baked.test.ts). `compositor-gpu bake`
// (tools/bake.ts) writes them with encodeBakedFont; the text backend reads
// them with decodeBakedFont.
//
// Layout (little-endian): "CGF1", version u32, unitsPerEm f64, ascender
// f64, descender f64; cmap: count u32, (codepoint u32, glyph u32)*,
// ascending; ligatures: count u32, (by u32, length u32, glyph u32*)*;
// glyphs: count u32, (glyph u32, byte offset u32)*, ascending, then the
// glyph records: advance f64, bbox x1 y1 x2 y2 f64 (used on the CPU, so
// kept exact), quads u32, quad (x0 y0 cx cy x1 y1 f32: the GPU's
// precision)*, then BAKED_BANDS row bands and BAKED_BANDS column bands,
// each count u16 and quad indices u16* (a glyph has under 65536 quads).
// About 1.1 KB a glyph before compression (a third of that gzipped).

export const BAKED_MAGIC = 0x31464743 // "CGF1"
export const BAKED_VERSION = 1
/** Must equal font.ts's BAND_COUNT (the shader reads gref.y bands). */
export const BAKED_BANDS = 16

/** One glyph's band lists: indices into its outline, per row band, then
 * per column band (the column bands hold the quads x/y-swapped). */
export function bandIndices(outline: readonly Quad[]): {
  rows: number[][]
  cols: number[][]
} {
  const bucket = (lo: (q: Quad) => number, hi: (q: Quad) => number) =>
    Array.from({ length: BAKED_BANDS }, (_, i) => {
      const yMin = i / BAKED_BANDS
      const yMax = (i + 1) / BAKED_BANDS
      const out: number[] = []
      outline.forEach((q, k) => {
        if (hi(q) >= yMin && lo(q) <= yMax) {
          out.push(k)
        }
      })
      return out
    })
  return {
    rows: bucket(
      (q) => Math.min(q.y0, q.cy, q.y1),
      (q) => Math.max(q.y0, q.cy, q.y1)
    ),
    cols: bucket(
      (q) => Math.min(q.x0, q.cx, q.x1),
      (q) => Math.max(q.x0, q.cx, q.x1)
    )
  }
}

export interface BakeSource {
  unitsPerEm: number
  ascender: number
  descender: number
  /** Codepoint -> glyph, already cut to the baked ranges. */
  cmap: ReadonlyMap<number, number>
  ligatures: readonly Ligature[]
  /** Glyph ids to bake (0, the cmap's, the ligatures'). */
  glyphs: readonly number[]
  glyph(index: number): GlyphBands
}

class Writer {
  private buf = new ArrayBuffer(1 << 16)
  private view = new DataView(this.buf)
  length = 0
  private room(n: number): void {
    if (this.length + n <= this.buf.byteLength) {
      return
    }
    let size = this.buf.byteLength * 2
    while (size < this.length + n) {
      size *= 2
    }
    const next = new ArrayBuffer(size)
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.length))
    this.buf = next
    this.view = new DataView(next)
  }
  u32(v: number): void {
    this.room(4)
    this.view.setUint32(this.length, v, true)
    this.length += 4
  }
  f32(v: number): void {
    this.room(4)
    this.view.setFloat32(this.length, v, true)
    this.length += 4
  }
  u16(v: number): void {
    this.room(2)
    this.view.setUint16(this.length, v, true)
    this.length += 2
  }
  f64(v: number): void {
    this.room(8)
    this.view.setFloat64(this.length, v, true)
    this.length += 8
  }
  bytes(): ArrayBuffer {
    return this.buf.slice(0, this.length)
  }
}

/** Encode one instance (see the layout above). */
export function encodeBakedFont(src: BakeSource): ArrayBuffer {
  const w = new Writer()
  w.u32(BAKED_MAGIC)
  w.u32(BAKED_VERSION)
  w.f64(src.unitsPerEm)
  w.f64(src.ascender)
  w.f64(src.descender)
  const cmap = [...src.cmap].sort((a, b) => a[0] - b[0])
  w.u32(cmap.length)
  for (const [cp, g] of cmap) {
    w.u32(cp)
    w.u32(g)
  }
  w.u32(src.ligatures.length)
  for (const l of src.ligatures) {
    w.u32(l.by)
    w.u32(l.seq.length)
    for (const g of l.seq) {
      w.u32(g)
    }
  }
  // Glyph records into their own writer, offsets into the index.
  const ids = [...new Set(src.glyphs)].sort((a, b) => a - b)
  const g = new Writer()
  const offsets: number[] = []
  for (const id of ids) {
    offsets.push(g.length)
    const gb = src.glyph(id)
    g.f64(gb.advance)
    g.f64(gb.bbox.x1)
    g.f64(gb.bbox.y1)
    g.f64(gb.bbox.x2)
    g.f64(gb.bbox.y2)
    g.u32(gb.outline.length)
    for (const q of gb.outline) {
      g.f32(q.x0)
      g.f32(q.y0)
      g.f32(q.cx)
      g.f32(q.cy)
      g.f32(q.x1)
      g.f32(q.y1)
    }
    const { rows, cols } = bandIndices(gb.outline)
    for (const list of [...rows, ...cols]) {
      g.u16(list.length)
      for (const k of list) {
        g.u16(k)
      }
    }
  }
  w.u32(ids.length)
  ids.forEach((id, k) => {
    w.u32(id)
    w.u32(offsets[k] ?? 0)
  })
  const head = w.bytes()
  const body = g.bytes()
  const out = new Uint8Array(head.byteLength + body.byteLength)
  out.set(new Uint8Array(head), 0)
  out.set(new Uint8Array(body), head.byteLength)
  return out.buffer
}

const EMPTY: GlyphBands = {
  advance: 0,
  bbox: { x1: 0, y1: 0, x2: 0, y2: 0 },
  bands: [],
  vbands: [],
  curves: [],
  outline: []
}

/**
 * A ParsedFont over a baked instance: codepoints outside its ranges map to
 * glyph 0, glyphs not baked are empty. Glyph records decode on first use
 * (outline as stored, rows then column bands in the order font.ts builds
 * them).
 */
export function decodeBakedFont(
  buffer: ArrayBuffer,
  fontId: number
): ParsedFont {
  const v = new DataView(buffer)
  let p = 0
  const u32 = (): number => {
    const x = v.getUint32(p, true)
    p += 4
    return x
  }
  const f32 = (): number => {
    const x = v.getFloat32(p, true)
    p += 4
    return x
  }
  const u16 = (): number => {
    const x = v.getUint16(p, true)
    p += 2
    return x
  }
  const f64 = (): number => {
    const x = v.getFloat64(p, true)
    p += 8
    return x
  }
  if (u32() !== BAKED_MAGIC) {
    throw new Error('not a baked font (bad magic)')
  }
  const version = u32()
  if (version !== BAKED_VERSION) {
    throw new Error(`baked font version ${version}, expected ${BAKED_VERSION}`)
  }
  const unitsPerEm = f64()
  const ascender = f64()
  const descender = f64()
  const cmap = new Map<number, number>()
  for (let n = u32(); n > 0; n--) {
    const cp = u32()
    cmap.set(cp, u32())
  }
  const ligatures = new Map<number, Ligature[]>()
  for (let n = u32(); n > 0; n--) {
    const by = u32()
    const len = u32()
    const seq: number[] = []
    for (let k = 0; k < len; k++) {
      seq.push(u32())
    }
    const first = seq[0]
    if (first !== undefined) {
      const bucket = ligatures.get(first) ?? []
      bucket.push({ seq, by })
      ligatures.set(first, bucket)
    }
  }
  for (const bucket of ligatures.values()) {
    bucket.sort((a, b) => b.seq.length - a.seq.length)
  }
  const index = new Map<number, number>()
  const count = u32()
  const offsets: [number, number][] = []
  for (let k = 0; k < count; k++) {
    const id = u32()
    offsets.push([id, u32()])
  }
  const body = p
  for (const [id, off] of offsets) {
    index.set(id, body + off)
  }
  const cache = new Map<number, GlyphBands>()

  const glyph = (id: number): GlyphBands => {
    const hit = cache.get(id)
    if (hit) {
      return hit
    }
    const at = index.get(id)
    if (at === undefined) {
      return EMPTY
    }
    p = at
    const advance = f64()
    const bbox = { x1: f64(), y1: f64(), x2: f64(), y2: f64() }
    const outline: Quad[] = []
    for (let n = u32(); n > 0; n--) {
      outline.push({
        x0: f32(),
        y0: f32(),
        cx: f32(),
        cy: f32(),
        x1: f32(),
        y1: f32()
      })
    }
    const curves: Quad[] = []
    const bucket = (swap: boolean): GlyphBands['bands'] =>
      Array.from({ length: BAKED_BANDS }, (_, i) => {
        const start = curves.length
        for (let n = u16(); n > 0; n--) {
          const q = outline[u16()] as Quad
          curves.push(
            swap
              ? { x0: q.y0, y0: q.x0, cx: q.cy, cy: q.cx, x1: q.y1, y1: q.x1 }
              : q
          )
        }
        return {
          yMin: i / BAKED_BANDS,
          yMax: (i + 1) / BAKED_BANDS,
          start,
          end: curves.length
        }
      })
    const bands = bucket(false)
    const vbands = bucket(true)
    const g: GlyphBands = { advance, bbox, bands, vbands, curves, outline }
    cache.set(id, g)
    return g
  }

  return {
    fontId,
    unitsPerEm,
    ascender,
    descender,
    glyphForCodePoint: (cp) => cmap.get(cp) ?? 0,
    glyph,
    ligatureAt(ids, i) {
      const first = ids[i]
      const bucket = first === undefined ? undefined : ligatures.get(first)
      if (!bucket) {
        return null
      }
      for (const { seq, by } of bucket) {
        if (i + seq.length > ids.length) {
          continue
        }
        let k = 1
        while (k < seq.length && ids[i + k] === seq[k]) {
          k++
        }
        if (k === seq.length) {
          return { len: seq.length, by }
        }
      }
      return null
    }
  }
}

/** One baked face in a manifest. */
export interface BakedFace {
  /** CSS family as the page names it (matched case-insensitively). */
  family: string
  weight: number
  italic: boolean
  /** Optical size baked at (the font's opsz axis), or null when the font
   * has none. A run uses this face only at that opsz (its font-size,
   * clamped to `opszRange`). */
  opsz: number | null
  opszRange: [number, number] | null
  /** The opsz axis default (what a run without optical sizing uses). */
  opszDefault: number | null
  /** wght axis range of the source (variable fonts): a run's weight is
   * clamped to it before matching, as the runtime instancing does. */
  wghtRange: [number, number] | null
  /** Relative to the manifest. */
  url: string
  glyphs: number
  bytes: number
  /** The baked unicode ranges, CSS syntax. */
  unicodeRange: string
}

export interface BakedManifest {
  version: number
  fonts: BakedFace[]
}
