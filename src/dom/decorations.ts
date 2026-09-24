// text-decoration lines (underline / overline / line-through): reading the
// computed style, propagating it down the element tree, and building the
// BoxRecords flatten() paints just before a run's glyphs (see records.ts:
// GlyphRun.decorations).
//
// CSS `text-decoration` is not inherited, but ancestor decorations keep
// painting across in-flow descendant text (a decorating <a> underlines a
// nested <span>'s text) until an out-of-flow descendant or an atomic inline
// (its own decorating box, CSS Text Decoration §4.5) breaks the chain. Each
// entry records which element decorates and with what font, so geometry is
// derived from the DECORATING element's metrics, not the text's.
//
// Only `text-decoration-style: solid` is drawn faithfully; dotted, dashed,
// wavy and double all render as a plain solid line (no dash/wave pattern,
// no second stroke) — a known gap, not a bug.
import type { BoxRecord, Glyph, GlyphRun, RGBA, Rect } from '../scene/records'
import { parseColor } from '../util/color'
import { fontMetrics } from './textRuns'
import { type Placement, placementAabb, subPlacement } from './transform'

export type DecorationLine = 'underline' | 'overline' | 'line-through'

const LINES: readonly DecorationLine[] = [
  'underline',
  'overline',
  'line-through'
]

export interface Decoration {
  line: DecorationLine
  color: RGBA
  /** Explicit `text-decoration-thickness` in px, or null for `auto`. */
  thicknessPx: number | null
  /** The decorating element's computed font-size, px. */
  fontSize: number
  /** The decorating element's font ascent/descent, px (Canvas 2D
   * `fontBoundingBox*`, same measurement as textRuns.contentHeight). */
  ascent: number
  descent: number
}

const REPLACED_TAGS = new Set([
  'IMG',
  'VIDEO',
  'CANVAS',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'INPUT',
  'TEXTAREA',
  'SELECT'
])

function isOutOfFlow(s: CSSStyleDeclaration): boolean {
  return s.position === 'absolute' || s.position === 'fixed'
}

function isAtomicInline(el: Element, s: CSSStyleDeclaration): boolean {
  const d = s.display
  if (d === 'inline-block' || d === 'inline-flex' || d === 'inline-grid') {
    return true
  }
  return REPLACED_TAGS.has(el.tagName)
}

/** This element's own `text-decoration-line` entries, or null if it
 * declares none (`none`, or unparseable). */
export function readOwnDecorations(
  s: CSSStyleDeclaration
): Decoration[] | null {
  const raw = s.textDecorationLine
  if (!raw || raw === 'none') return null
  const lines = raw
    .split(/\s+/)
    .filter((l): l is DecorationLine =>
      (LINES as readonly string[]).includes(l)
    )
  if (lines.length === 0) return null

  const color = parseColor(s.textDecorationColor || s.color)
  const fontSize = Number.parseFloat(s.fontSize) || 16
  const thicknessRaw = s.textDecorationThickness
  let thicknessPx: number | null = null
  if (thicknessRaw && thicknessRaw !== 'auto') {
    const n = Number.parseFloat(thicknessRaw)
    thicknessPx = Number.isFinite(n) ? n : null
  }
  const { ascent, descent } = fontMetrics(s)
  return lines.map((line) => ({
    line,
    color,
    thicknessPx,
    fontSize,
    ascent,
    descent
  }))
}

/**
 * `decor` to thread into `el`'s children: this element's own decorations
 * appended to what propagated in from ancestors, or — at an out-of-flow or
 * atomic-inline boundary — this element's own decorations alone (CSS stops
 * propagation there; see module doc).
 */
export function propagateDecorations(
  el: Element,
  s: CSSStyleDeclaration,
  parentDecor: Decoration[] | null
): Decoration[] | null {
  const ownDecor = readOwnDecorations(s)
  if (isOutOfFlow(s) || isAtomicInline(el, s)) return ownDecor
  if (!ownDecor) return parentDecor
  return parentDecor ? [...parentDecor, ...ownDecor] : ownDecor
}

/** Same-line grouping: consecutive glyphs whose rect.y agree within this. */
const LINE_EPS = 1

/**
 * One BoxRecord per (decoration entry × line fragment) for a run, geometry
 * built in the FIRST glyph of each fragment's local frame (see CLAUDE.md /
 * transform.ts): cheap and exact for untransformed runs, and correct under
 * rotation/skew because the stroke is placed and sized in local space before
 * `xform` carries it to document space.
 */
export function buildDecorationBoxes(
  run: GlyphRun,
  decor: readonly Decoration[],
  clip: Rect | null,
  allocId: () => number
): BoxRecord[] {
  if (decor.length === 0) return []
  const glyphs = run.glyphs
  const out: BoxRecord[] = []
  let start = 0
  for (let i = 1; i <= glyphs.length; i++) {
    const prev = glyphs[i - 1] as Glyph
    const cur: Glyph | undefined = glyphs[i]
    if (cur && Math.abs(cur.rect.y - prev.rect.y) < LINE_EPS) continue
    const g0 = glyphs[start] as Glyph
    for (const d of decor) {
      out.push(decorationBox(g0, prev, d, clip, allocId()))
    }
    start = i
  }
  return out
}

/** Local x of `gLast`'s right edge, in `g0`'s local frame: glyphs in a run
 * share the same linear part, so this is `inv(lin) · (t_last − t_first)`
 * (the origin shift) plus `gLast`'s own local width. */
function fragmentRightX(g0: Glyph, gLast: Glyph): number {
  const [a, b, c, d, tx0, ty0] = g0.xform
  const dx = gLast.xform[4] - tx0
  const dy = gLast.xform[5] - ty0
  const det = a * d - b * c
  const ix = det !== 0 ? (d * dx - c * dy) / det : dx
  return ix + gLast.local.w
}

function decorationBox(
  g0: Glyph,
  gLast: Glyph,
  d: Decoration,
  clip: Rect | null,
  id: number
): BoxRecord {
  const xLast = fragmentRightX(g0, gLast)

  // Slug baseline rule (see rasterizer.ts): the decorating element's own
  // font metrics, centred in the line box, not the text run's.
  const localH = g0.local.h
  const baseline = (localH - (d.ascent + d.descent)) / 2 + d.ascent
  const fontSize = d.fontSize
  const thickness = Math.max(
    1,
    Math.round(d.thicknessPx ?? Math.max(1, fontSize / 10))
  )

  // Underline and line-through are positioned by their vertical CENTER
  // (Chrome centers the stroke on the nominal position, it doesn't hang it
  // from a top edge); overline's formula is already a top edge.
  let top: number
  if (d.line === 'underline') {
    const center = baseline + Math.max(1, 0.1 * fontSize)
    top = center - thickness / 2
  } else if (d.line === 'overline') {
    // `baseline - ascent` alone (the top of the font's own em box) sits
    // ~0.1em too low against Chrome's overline for Inter; tuned by the
    // same 0.1em margin the underline uses, on the other side of the text.
    top = baseline - d.ascent - Math.max(1, 0.1 * fontSize)
  } else {
    const center = baseline - 0.3 * fontSize
    top = center - thickness / 2
  }
  top = Math.round(top)

  const p0: Placement = { xform: g0.xform, local: g0.local }
  const place = subPlacement(p0, 0, top, Math.max(0, xLast), thickness)
  const rect = placementAabb(place)

  return {
    kind: 'box',
    id,
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    },
    xform: place.xform,
    local: place.local,
    radius: [0, 0, 0, 0],
    fill: d.color,
    border: null,
    opacity: 1,
    z: 0,
    clip
  }
}
