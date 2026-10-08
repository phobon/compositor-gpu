import type { BoxRecord, GlyphRun, Rect, RGBA } from '../scene/records'
import { parseColor } from '../util/color'
import { toDocRect } from './styles'
import { graphemes } from './textRuns'

// The document selection's highlight (`::selection`): boxes of the
// selected part of each text node, painted under its glyphs, and the
// selected glyphs' colour (`colorSelected`).

let fallback: RGBA | null = null
/** The selection's ranges, snapshot by beginSelectionRead. */
let ranges: Range[] = []
/** Per read: highlight colour and line height per element. */
const styleCache = new Map<Element, { fill: RGBA; lh: number }>()
/** Per read: selected text colour per element (null: keeps its own). */
const textCache = new Map<Element, RGBA | null>()
/** Chrome on macOS keeps the text colour under the default highlight. */
let keepsColour: boolean | null = null
let fallbackText: RGBA | null = null

/** Snapshot the selection for this read pass (empty when collapsed). */
export function beginSelectionRead(): void {
  const sel = document.getSelection()
  ranges = []
  styleCache.clear()
  textCache.clear()
  if (!sel || sel.isCollapsed) {
    return
  }
  for (let i = 0; i < sel.rangeCount; i++) {
    ranges.push(sel.getRangeAt(i))
  }
}

/** The `::selection` background of text in `el`; the system `Highlight`
 * colour when the page sets none. */
function selectionColor(el: Element): RGBA {
  const c = parseColor(getComputedStyle(el, '::selection').backgroundColor)
  if (c.a > 0.001) {
    return c
  }
  fallback ??= parseColor('Highlight')
  return fallback
}

/** The selected `[start, end)` offsets of `node`, one per range. */
function selectedSpans(node: Text): [number, number][] {
  const out: [number, number][] = []
  for (const r of ranges) {
    if (!r.intersectsNode(node)) {
      continue
    }
    const start = r.startContainer === node ? r.startOffset : 0
    const end = r.endContainer === node ? r.endOffset : node.length
    if (end > start) {
      out.push([start, end])
    }
  }
  return out
}

function sameColor(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a
}

/**
 * The colour of selected text in `el`, or null when it keeps `own`. A
 * `::selection` colour that differs from the element's is the page's;
 * with no `::selection` rule at all (transparent background) Chrome uses
 * `HighlightText`, except on macOS, where the text keeps its colour.
 */
function selectedTextColor(el: Element, own: RGBA): RGBA | null {
  const hit = textCache.get(el)
  if (hit !== undefined) {
    return hit
  }
  const cs = getComputedStyle(el, '::selection')
  let out: RGBA | null = parseColor(cs.color)
  if (sameColor(out, own)) {
    out = null
    if (parseColor(cs.backgroundColor).a <= 0.001) {
      keepsColour ??= /Mac|iPhone|iPad/.test(
        (navigator as { userAgentData?: { platform?: string } }).userAgentData
          ?.platform ?? navigator.platform
      )
      if (!keepsColour) {
        fallbackText ??= parseColor('HighlightText')
        out = sameColor(fallbackText, own) ? null : fallbackText
      }
    }
  }
  textCache.set(el, out)
  return out
}

/**
 * Recolour the glyphs of `run` (read from `node` with start index 0)
 * that lie in the selection. Glyph `index` is the grapheme's position in
 * the node, so its source offset comes from re-segmenting the text; only
 * selected nodes pay for it.
 */
export function colorSelected(node: Text, run: GlyphRun): void {
  const el = node.parentElement
  if (ranges.length === 0 || !el) {
    return
  }
  const spans = selectedSpans(node)
  if (spans.length === 0) {
    return
  }
  const color = selectedTextColor(el, run.color)
  if (!color) {
    return
  }
  const cells = graphemes(node.nodeValue ?? '')
  const offs = new Array<number>(cells.length)
  let off = 0
  for (let i = 0; i < cells.length; i++) {
    offs[i] = off
    off += (cells[i] ?? '').length
  }
  for (const g of run.glyphs) {
    const o = offs[g.index]
    if (o !== undefined && spans.some(([a, b]) => o >= a && o < b)) {
      g.color = color
    }
  }
}

/**
 * Highlight boxes for the selected part of `node`, or null when none of
 * it is selected. Doc-space AABBs of the selected fragment's client rects
 * (an approximation under a transform).
 */
export function selectionBoxes(
  node: Text,
  clip: Rect | null,
  alloc: () => number
): BoxRecord[] | null {
  const el = node.parentElement
  if (ranges.length === 0 || !el) {
    return null
  }
  let out: BoxRecord[] | null = null
  for (const [start, end] of selectedSpans(node)) {
    const sub = document.createRange()
    sub.setStart(node, start)
    sub.setEnd(node, end)
    let st = styleCache.get(el)
    if (!st) {
      st = {
        fill: selectionColor(el),
        lh: Number.parseFloat(getComputedStyle(el).lineHeight)
      }
      styleCache.set(el, st)
    }
    const { fill, lh } = st
    // The text's rects span the font's content area; Chrome highlights
    // the line box: grow them to the line height about their centre.
    for (const cr of sub.getClientRects()) {
      if (cr.width <= 0 || cr.height <= 0) {
        continue
      }
      const rect = toDocRect(cr)
      if (Number.isFinite(lh) && lh > rect.height) {
        rect.y -= (lh - rect.height) / 2
        rect.height = lh
      }
      out ??= []
      out.push({
        kind: 'box',
        id: alloc(),
        rect,
        xform: [1, 0, 0, 1, rect.x, rect.y],
        local: { w: rect.width, h: rect.height },
        radius: [0, 0, 0, 0],
        fill,
        gradient: null,
        border: null,
        opacity: 1,
        z: 0,
        clip
      })
    }
  }
  return out
}
