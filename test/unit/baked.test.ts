// Baked fonts (src/text/slug/baked.ts, tools/bake.ts): a baked instance
// decodes to the same glyphs, cmap and ligatures as parsing the font
// (outlines at the GPU's f32), so baked text draws exactly as parsed text.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decodeBakedFont } from '../../src/text/slug/baked'
import {
  type GlyphBands,
  loadFontFile,
  loadParser,
  makeInstance,
  type Quad
} from '../../src/text/slug/font'
import { bakeInstance, parseUnicodeRange } from '../../tools/bake'

const root = resolve(fileURLToPath(import.meta.url), '../../..')

const f32 = Math.fround
const q32 = (q: Quad): Quad => ({
  x0: f32(q.x0),
  y0: f32(q.y0),
  cx: f32(q.cx),
  cy: f32(q.cy),
  x1: f32(q.x1),
  y1: f32(q.y1)
})
/** A parsed glyph as the GPU sees it (curves and outline at f32). */
const atF32 = (g: GlyphBands): GlyphBands => ({
  ...g,
  curves: g.curves.map(q32),
  outline: g.outline.map(q32)
})

test('unicode ranges parse as CSS writes them', () => {
  assert.deepEqual(parseUnicodeRange('U+0020-007E, u+00??, U+20AC'), [
    [0x20, 0x7e],
    [0x00, 0xff],
    [0x20ac, 0x20ac]
  ])
})

test('a baked variable-font instance decodes to the parsed glyphs', async () => {
  await loadParser()
  const buf = readFileSync(resolve(root, 'playground/InterVariable.ttf'))
  const handle = loadFontFile(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  )
  const coords = { wght: 500, opsz: 32 }
  const ranges = parseUnicodeRange('U+0020-007E, U+00A0-00FF')
  const { bytes, glyphs } = bakeInstance(handle, ranges, coords)
  const baked = decodeBakedFont(bytes, 3)
  const parsed = makeInstance(handle, 3, coords)
  assert.equal(baked.unitsPerEm, parsed.unitsPerEm)
  assert.equal(baked.ascender, parsed.ascender)
  assert.equal(baked.descender, parsed.descender)
  let checked = 0
  for (let cp = 0x20; cp <= 0xff; cp++) {
    if (cp > 0x7e && cp < 0xa0) {
      continue
    }
    const id = parsed.glyphForCodePoint(cp)
    assert.equal(baked.glyphForCodePoint(cp), id, `cmap U+${cp.toString(16)}`)
    if (id !== 0) {
      assert.deepEqual(
        baked.glyph(id),
        atF32(parsed.glyph(id)),
        `glyph ${id} (U+${cp.toString(16)})`
      )
      checked++
    }
  }
  assert.ok(checked > 150, `${checked} glyphs compared`)
  assert.ok(glyphs >= checked)
  // Outside the ranges: glyph 0 (the runtime falls back for those).
  assert.equal(baked.glyphForCodePoint(0x4e00), 0)
  // Ligatures among the baked glyphs match (f + i, if the font has it).
  const ids = [...'fi'].map((c) =>
    parsed.glyphForCodePoint(c.codePointAt(0) ?? 0)
  )
  assert.deepEqual(baked.ligatureAt(ids, 0), parsed.ligatureAt(ids, 0))
})
