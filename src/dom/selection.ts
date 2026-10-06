import type { BoxRecord, Rect, RGBA } from '../scene/records'
import { parseColor } from '../util/color'
import { toDocRect } from './styles'

// The document selection's highlight (`::selection`): boxes of the
// selected part of each text node, painted under its glyphs. The selected
// text keeps its own colour (the `::selection` `color` is not applied).

let fallback: RGBA | null = null
/** The selection's ranges, snapshot by beginSelectionRead. */
let ranges: Range[] = []
/** Per read: highlight colour and line height per element. */
const styleCache = new Map<Element, { fill: RGBA; lh: number }>()

/** Snapshot the selection for this read pass (empty when collapsed). */
export function beginSelectionRead(): void {
  const sel = document.getSelection()
  ranges = []
  styleCache.clear()
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
  for (const r of ranges) {
    if (!r.intersectsNode(node)) {
      continue
    }
    const start = r.startContainer === node ? r.startOffset : 0
    const end = r.endContainer === node ? r.endOffset : node.length
    if (end <= start) {
      continue
    }
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
