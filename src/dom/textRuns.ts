import type { Glyph, GlyphRun } from '../scene/records'
import { parseColor } from '../util/color'
import { toDocRect } from './styles'

// Grapheme segmenter (browser-native). Falls back to Array.from for old envs.
const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

function graphemes(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment)
  return Array.from(text)
}

/**
 * Extract per-glyph geometry from a single text node by ranging over each
 * grapheme and reading its client rect. This inherits the browser's shaping,
 * kerning, bidi and line breaks — the whole point of "replicating the HTML
 * text". Ligatures make per-grapheme rects approximate; acceptable for v1.
 *
 * NOTE: getClientRects here is a forced layout read. The caller MUST batch all
 * of these before any GPU write in a frame (see observer/sync).
 *
 * `s` is the computed style of the text node's parent element.
 *
 * `glyphId` is set to the grapheme's first code point as a placeholder; the
 * Slug font stage remaps it through the font cmap to a real glyph index.
 */
export function readTextNode(
  node: Text,
  s: CSSStyleDeclaration,
  runId: number,
  fontId: number,
  startIndex: number
): GlyphRun | null {
  const text = node.nodeValue
  if (!text || !text.trim()) return null
  const color = parseColor(s.color)
  const fontSize = Number.parseFloat(s.fontSize) || 16
  const fontFamily = (s.fontFamily.split(',')[0] ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
  const fontWeight = Number.parseInt(s.fontWeight, 10) || 400
  const italic = s.fontStyle === 'italic' || s.fontStyle.startsWith('oblique')
  const glyphs: Glyph[] = []

  const range = document.createRange()
  const cells = graphemes(text)
  let offset = 0
  let index = startIndex
  for (const cell of cells) {
    const len = cell.length
    if (cell.trim().length === 0) {
      offset += len
      index += 1
      continue
    }
    range.setStart(node, offset)
    range.setEnd(node, offset + len)
    const r = range.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) {
      glyphs.push({
        index,
        rect: toDocRect(r),
        glyphId: cell.codePointAt(0) ?? 0,
        text: cell,
        fontId,
        fontSize,
        color,
        offset: { x: 0, y: 0 }
      })
    }
    offset += len
    index += 1
  }
  range.detach?.()
  if (glyphs.length === 0) return null
  return {
    kind: 'text',
    id: runId,
    fontId,
    fontFamily,
    fontStack: s.fontFamily,
    fontWeight,
    italic,
    color,
    glyphs,
    opacity: 1,
    z: 0
  }
}
