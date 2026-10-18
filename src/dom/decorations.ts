// text-decoration lines (underline / overline / line-through): reading the
// computed style, propagating it down the element tree, and building the
// BoxRecords flatten() paints around a run's glyphs (see records.ts:
// GlyphRun.decorations / decorationsOver).
//
// CSS `text-decoration` is not inherited, but ancestor decorations keep
// painting across in-flow descendant text (a decorating <a> underlines a
// nested <span>'s text) until an out-of-flow descendant or an atomic inline
// (its own decorating box, CSS Text Decoration §4.5) breaks the chain. Each
// entry records which element decorates and with what font, so geometry is
// derived from the DECORATING element's metrics, not the text's.
//
// `text-decoration-style`: solid and double are plain boxes (double adds a
// second one thickness + 1px away, as Blink does); dashed, dotted and wavy
// are boxes with `line` set, whose pattern the box shader draws.
import type { BoxRecord, Glyph, GlyphRun, Rect, RGBA } from '../scene/records'
import { parseColor } from '../util/color'
import { fontMetrics, measureGlyphInk } from './text_runs'
import { type Placement, placementAabb, subPlacement } from './transform'

export type DecorationLine = 'underline' | 'overline' | 'line-through'

export type DecorationStyle = 'solid' | 'double' | 'dotted' | 'dashed' | 'wavy'

const LINES: readonly DecorationLine[] = [
  'underline',
  'overline',
  'line-through'
]

export interface Decoration {
  line: DecorationLine
  style: DecorationStyle
  color: RGBA
  /** Explicit `text-decoration-thickness` in px, or null for `auto`. */
  thicknessPx: number | null
  /** The decorating element's computed font-size, px. */
  fontSize: number
  /** The decorating element's font ascent/descent, px (Canvas 2D
   * `fontBoundingBox*`, same measurement as textRuns.contentHeight). */
  ascent: number
  descent: number
  /** `text-decoration-skip-ink` is not `none` (default is `auto`): break the
   * `underline` around descenders (p, g, y, …). Only applies to `underline`. */
  skipInk: boolean
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
  if (!raw || raw === 'none') {
    return null
  }
  const lines = raw
    .split(/\s+/)
    .filter((l): l is DecorationLine =>
      (LINES as readonly string[]).includes(l)
    )
  if (lines.length === 0) {
    return null
  }

  const color = parseColor(s.textDecorationColor || s.color)
  const fontSize = Number.parseFloat(s.fontSize) || 16
  const thicknessRaw = s.textDecorationThickness
  let thicknessPx: number | null = null
  if (thicknessRaw && thicknessRaw !== 'auto') {
    const n = Number.parseFloat(thicknessRaw)
    // A percentage is of 1em (the decorating element's font-size).
    const v = thicknessRaw.endsWith('%') ? (n / 100) * fontSize : n
    thicknessPx = Number.isFinite(v) ? v : null
  }
  const { ascent, descent } = fontMetrics(s)
  const skipInk = s.textDecorationSkipInk !== 'none'
  const st = s.textDecorationStyle
  const style: DecorationStyle =
    st === 'double' || st === 'dotted' || st === 'dashed' || st === 'wavy'
      ? st
      : 'solid'
  return lines.map((line) => ({
    line,
    style,
    color,
    thicknessPx,
    fontSize,
    ascent,
    descent,
    skipInk
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
  if (isOutOfFlow(s) || isAtomicInline(el, s)) {
    return ownDecor
  }
  if (!ownDecor) {
    return parentDecor
  }
  return parentDecor ? [...parentDecor, ...ownDecor] : ownDecor
}

/** Same-line grouping: glyphs whose local y (in the fragment's first
 * glyph's frame) agree within this. */
const LINE_EPS = 1

/** A run's decoration boxes, split by paint position: underline and
 * overline paint under the glyphs, line-through over them. */
export interface DecorationBoxes {
  under: BoxRecord[]
  over: BoxRecord[]
}

/**
 * One BoxRecord per (decoration entry × line fragment) for a run, geometry
 * built in the FIRST glyph of each fragment's local frame (see CLAUDE.md /
 * transform.ts): cheap and exact for untransformed runs, and correct under
 * rotation/skew because the stroke is placed and sized in local space before
 * `xform` carries it to document space. Line fragments are found in that
 * frame too, so a rotated line isn't split per glyph.
 */
export function buildDecorationBoxes(
  run: GlyphRun,
  decor: readonly Decoration[],
  clip: Rect | null,
  allocId: () => number
): DecorationBoxes {
  const out: DecorationBoxes = { under: [], over: [] }
  if (decor.length === 0) {
    return out
  }
  const glyphs = run.glyphs
  let start = 0
  for (let i = 1; i <= glyphs.length; i++) {
    const g0 = glyphs[start] as Glyph
    const cur: Glyph | undefined = glyphs[i]
    if (cur && Math.abs(glyphLocalY(g0, cur)) < LINE_EPS) {
      continue
    }
    for (const d of decor) {
      const list = d.line === 'line-through' ? out.over : out.under
      list.push(...fragmentBoxes(run, glyphs, start, i, d, clip, allocId))
    }
    start = i
  }
  return out
}

/** Local y of `g`'s top edge in `g0`'s local frame (see glyphLocalX). */
function glyphLocalY(g0: Glyph, g: Glyph): number {
  const [a, b, c, d, tx0, ty0] = g0.xform
  const dx = g.xform[4] - tx0
  const dy = g.xform[5] - ty0
  const det = a * d - b * c
  return det !== 0 ? (a * dy - b * dx) / det : dy
}

/** Local x of `g`'s left (advance-box) edge, in `g0`'s local frame: glyphs
 * in a run share the same linear part, so this is `inv(lin) · (t_g − t_0)`
 * (the origin shift). */
function glyphLocalX(g0: Glyph, g: Glyph): number {
  const [a, b, c, d, tx0, ty0] = g0.xform
  const dx = g.xform[4] - tx0
  const dy = g.xform[5] - ty0
  const det = a * d - b * c
  return det !== 0 ? (d * dx - c * dy) / det : dx
}

/** Local x of `gLast`'s right edge, in `g0`'s local frame. */
function fragmentRightX(g0: Glyph, gLast: Glyph): number {
  return glyphLocalX(g0, gLast) + gLast.local.w
}

/** One or more BoxRecords for `d` over glyphs `[start, end)` of `run`: a
 * single box spanning the fragment, except for `underline` with
 * `skip-ink`, which is split around glyphs whose ink intrudes into the
 * underline band. */
function fragmentBoxes(
  run: GlyphRun,
  glyphs: Glyph[],
  start: number,
  end: number,
  d: Decoration,
  clip: Rect | null,
  allocId: () => number
): BoxRecord[] {
  const g0 = glyphs[start] as Glyph
  const gLast = glyphs[end - 1] as Glyph
  const xLast = Math.max(0, fragmentRightX(g0, gLast))

  // Slug baseline rule (see rasterizer.ts): the decorating element's own
  // font metrics, centred in the line box, not the text run's.
  const localH = g0.local.h
  const baseline = (localH - (d.ascent + d.descent)) / 2 + d.ascent
  // Blink's resolved thickness: font-size / 10 for `auto`, else the
  // length rounded (text_decoration_info.cc); at least 1px.
  const t = Math.max(
    1,
    d.thicknessPx === null ? d.fontSize / 10 : Math.round(d.thicknessPx)
  )
  // Line rect top (TextDecorationOffset / SetLineThroughLineData), from
  // the text top: an underline sits max(1, ceil(t / 2)) under the
  // baseline, an overline's bottom on the text top, a line-through's
  // centre two thirds of the ascent down.
  const textTop = baseline - d.ascent
  let y0: number
  if (d.line === 'underline') {
    y0 = textTop + Math.round(d.ascent) + Math.max(1, Math.ceil(t / 2))
  } else if (d.line === 'overline') {
    y0 = textTop - Math.floor(t)
  } else {
    y0 = textTop + (2 * d.ascent) / 3 - t / 2
  }

  // DecorationLinePainter: solid and double lines are rects snapped to
  // whole px, max(1, floor(t)) high; the second line of a double sits
  // t + 1 below an underline (floor(t + 1) below a line-through) and above
  // an overline, as does the wave's centreline (a line-through's stays on
  // the line). Dashes and dots are a stroke of round(t) centred on
  // floor(y + t / 2), +0.5 when odd.
  const off =
    d.line === 'overline'
      ? -(t + 1)
      : d.line === 'line-through' && d.style === 'double'
        ? Math.floor(t + 1)
        : t + 1
  const solidH = Math.max(1, Math.floor(t))
  // Paint band (local y, height) of each stroke, and the skip-ink stripe's
  // top for it.
  const bands: Array<[number, number, number]> = [
    [Math.floor(y0 + 0.5), solidH, y0]
  ]
  let line: BoxRecord['line']
  let mid = 0
  if (d.style === 'double') {
    bands.push([Math.floor(y0 + off + 0.5), solidH, y0 + off])
  } else if (d.style === 'dashed' || d.style === 'dotted') {
    const w = Math.max(1, Math.round(t))
    const midY = Math.floor(y0 + Math.max(t / 2, 0.5))
    bands[0] = [midY - Math.floor(w / 2), w, y0]
    line = { style: d.style, thickness: w, start: 0, length: 0, mid: 0 }
  } else if (d.style === 'wavy') {
    // The centreline (MakeWave's y = 0.5) and the curve's reach either
    // side of it: 0.289 of the control point distance, plus half the
    // stroke; the box adds a pixel of AA.
    mid = y0 + (d.line === 'line-through' ? 0 : off) + 0.5
    const cp = 0.5 + Math.round(3 * t + 0.5)
    const reach = 0.289 * cp + t / 2
    const r = Math.ceil(reach + 1)
    bands[0] = [Math.floor(mid) - r, 2 * r + 1, Math.floor(mid - reach)]
    line = { style: 'wavy', thickness: t, start: 0, length: 0, mid: 0 }
  }

  // Dashes and dots run between end points truncated to whole px
  // (DrawLineAsStroke's gfx::Point), here when the text is untransformed.
  let x0 = 0
  let x1 = xLast
  const [la, lb, lc, ld, tx] = g0.xform
  const plain = la === 1 && lb === 0 && lc === 0 && ld === 1
  const whole = line !== undefined && line.style !== 'wavy' && plain
  if (whole) {
    x0 = Math.floor(tx) - tx
    x1 = Math.floor(tx + xLast) - tx
  }

  const boxes: BoxRecord[] = []
  for (const [y, h, stripe] of bands) {
    const segments =
      d.line === 'underline' && d.skipInk
        ? skipInkSegments(run, glyphs, start, end, g0, baseline, stripe)
        : [[0, xLast] as [number, number]]
    for (const [sL, sR] of segments) {
      let xL = sL === 0 ? x0 : Math.max(sL, x0)
      let xR = sR === xLast ? x1 : Math.min(sR, x1)
      if (whole) {
        // Whole-px skip-ink cuts too: the box pass snaps a box's edges to
        // device pixels, which would shift the pattern inside it.
        xL = Math.round(tx + xL) - tx
        xR = Math.round(tx + xR) - tx
      }
      if (xR <= xL) {
        continue
      }
      const box = makeDecorationBox(g0, xL, xR, y, h, d, clip, allocId())
      if (line) {
        box.line = {
          ...line,
          start: xL - x0,
          length: Math.round(x1 - x0),
          mid: mid - y
        }
      }
      boxes.push(box)
    }
  }
  return boxes
}

/** `max(1, 0.06 * fontSize)`: the padding added around each glyph's ink
 * extent before it's cut from the underline, tuned against Chrome's
 * `skip-ink: auto` (harness `decorations` section). */
function skipInkGap(fontSize: number): number {
  return Math.max(1, 0.06 * fontSize)
}

/**
 * Local-x ranges `[0, xLast]` (in `g0`'s frame) still covered by the
 * underline once glyphs whose ink reaches into the underline band
 * (`[top, top + thickness]`) have their horizontal ink extent, padded by
 * `skipInkGap`, cut out. One canvas `measureText` per grapheme (cached).
 */
function skipInkSegments(
  run: GlyphRun,
  glyphs: Glyph[],
  start: number,
  end: number,
  g0: Glyph,
  baseline: number,
  top: number
): Array<[number, number]> {
  const xLast = Math.max(0, fragmentRightX(g0, glyphs[end - 1] as Glyph))
  const cuts: Array<[number, number]> = []
  for (let i = start; i < end; i++) {
    const g = glyphs[i] as Glyph
    const ink = measureGlyphInk(
      g.text,
      run.fontFamily,
      run.fontWeight,
      run.italic,
      g.fontSize
    )
    if (!ink) {
      continue
    }
    // Ink reaching past the top of the underline band intrudes on it.
    if (ink.descent <= top - baseline) {
      continue
    }
    const glyphLeft = glyphLocalX(g0, g)
    // Prefer the descender-only span (just the sub-baseline stroke) over
    // the whole glyph's ink bbox — a 'p' or 'g's bowl sits above the
    // baseline and would otherwise widen the gap to nearly the full glyph.
    const left =
      ink.descLeft !== undefined ? ink.descLeft : Math.max(0, -ink.left)
    const right = ink.descRight !== undefined ? ink.descRight : ink.right
    const inkL = glyphLeft + Math.max(0, left)
    const inkR = glyphLeft + right
    const gap = skipInkGap(g.fontSize)
    cuts.push([inkL - gap, inkR + gap])
  }
  if (cuts.length === 0) {
    return [[0, xLast]]
  }
  cuts.sort((a, b) => a[0] - b[0])

  // Merge overlapping/adjacent cuts, then take the complement within
  // [0, xLast].
  const merged: Array<[number, number]> = []
  for (const c of cuts) {
    const last = merged[merged.length - 1]
    if (last && c[0] <= last[1]) {
      last[1] = Math.max(last[1], c[1])
    } else {
      merged.push([...c])
    }
  }
  const out: Array<[number, number]> = []
  let cursor = 0
  for (const [cL, cR] of merged) {
    const segL = Math.max(0, cursor)
    const segR = Math.min(xLast, cL)
    if (segR - segL >= 1) {
      out.push([segL, segR])
    }
    cursor = Math.max(cursor, cR)
  }
  if (xLast - cursor >= 1) {
    out.push([Math.max(0, cursor), xLast])
  }
  return out
}

function makeDecorationBox(
  g0: Glyph,
  xL: number,
  xR: number,
  top: number,
  thickness: number,
  d: Decoration,
  clip: Rect | null,
  id: number
): BoxRecord {
  const p0: Placement = { xform: g0.xform, local: g0.local }
  const place = subPlacement(p0, xL, top, Math.max(0, xR - xL), thickness)
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
