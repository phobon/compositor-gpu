import type { Gradient, GradientStop, Rect, RGBA } from '../scene/records'
import { parseColor } from '../util/color'
import { splitTopLevel } from '../util/css'

/** Colour parser used for stop colours; injectable so tests can stub it. */
export type ColorParser = (css: string) => RGBA

/** Max stops per gradient (the shader's evaluation loop assumes this). */
export const MAX_STOPS = 8

/**
 * The layers of a computed `background-image` list, top-most first
 * (verbatim; `url(...)`, gradients, or `none` for an empty layer). Empty
 * for `none`.
 */
export function backgroundLayers(backgroundImage: string): string[] {
  const bgi = backgroundImage.trim()
  if (bgi === '' || bgi === 'none') {
    return []
  }
  return splitTopLevel(bgi, ',').map((l) => l.trim())
}

/**
 * First layer of a computed `background-image` list, or null for `none` /
 * empty. The layer is returned verbatim (may be a `url(...)`).
 */
export function firstBackgroundLayer(backgroundImage: string): string | null {
  const first = splitTopLevel(backgroundImage.trim(), ',')[0] ?? ''
  if (first === '' || first === 'none') {
    return null
  }
  return first
}

const ANGLE_RE = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(deg|rad|turn|grad)?$/i
const LEN_RE = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(px|%)?$/i

/** CSS angle token -> radians, or null when it isn't an angle. */
function parseAngle(tok: string): number | null {
  const m = ANGLE_RE.exec(tok)
  if (!m) {
    return null
  }
  const n = Number.parseFloat(m[1] ?? '')
  const unit = (m[2] ?? '').toLowerCase()
  if (!Number.isFinite(n)) {
    return null
  }
  // Unitless is only valid for 0.
  if (unit === '') {
    return n === 0 ? 0 : null
  }
  if (unit === 'deg') {
    return (n * Math.PI) / 180
  }
  if (unit === 'grad') {
    return (n * Math.PI) / 200
  }
  if (unit === 'turn') {
    return n * 2 * Math.PI
  }
  return n
}

type Len = { value: number; pct: boolean }

/** `<n>px`, `<n>%`, or unitless 0. */
function parseLen(tok: string): Len | null {
  const m = LEN_RE.exec(tok)
  if (!m) {
    return null
  }
  const n = Number.parseFloat(m[1] ?? '')
  if (!Number.isFinite(n)) {
    return null
  }
  const unit = m[2] ?? ''
  if (unit === '' && n !== 0) {
    return null
  }
  return { value: n, pct: unit === '%' }
}

/**
 * `to <side-or-corner>` -> CSS angle (radians, 0 = up, clockwise), resolved
 * against the box for corners. A corner angle makes the 50% line pass
 * through the two neighbouring corners ("magic corners"), so it is
 * perpendicular to that diagonal: for `to top right`, direction ∝ (h, -w)
 * in y-down space, i.e. θ = atan2(h, w).
 */
function parseToKeywords(words: string[], rect: Rect): number | null {
  let h = 0 // -1 left, 1 right
  let v = 0 // -1 top, 1 bottom
  for (const w of words) {
    if (w === 'left' && h === 0) {
      h = -1
    } else if (w === 'right' && h === 0) {
      h = 1
    } else if (w === 'top' && v === 0) {
      v = -1
    } else if (w === 'bottom' && v === 0) {
      v = 1
    } else {
      return null
    }
  }
  if (h === 0 && v === 0) {
    return null
  }
  if (h === 0) {
    return v < 0 ? 0 : Math.PI
  }
  if (v === 0) {
    return h > 0 ? Math.PI / 2 : (3 * Math.PI) / 2
  }
  const a = Math.atan2(rect.height, rect.width) // to top right
  if (v < 0) {
    return h > 0 ? a : 2 * Math.PI - a
  }
  return h > 0 ? Math.PI - a : Math.PI + a
}

/** Split one stop argument into its colour and 0-2 position tokens. */
function splitStop(arg: string): { color: string; positions: string[] } {
  const ws = arg.search(/\s/)
  const paren = arg.indexOf('(')
  let end: number
  if (paren >= 0 && (ws < 0 || paren < ws)) {
    // Functional colour: find the matching close paren.
    let depth = 0
    end = arg.length
    for (let i = paren; i < arg.length; i++) {
      const ch = arg[i]
      if (ch === '(') {
        depth++
      } else if (ch === ')' && --depth === 0) {
        end = i + 1
        break
      }
    }
  } else {
    end = ws < 0 ? arg.length : ws
  }
  const rest = arg.slice(end).trim()
  return {
    color: arg.slice(0, end),
    positions: rest === '' ? [] : rest.split(/\s+/)
  }
}

/**
 * Parse stop arguments into fixed-up stops. Positions: % -> fraction, px ->
 * divided by `lineLength`. Unparseable positions (e.g. calc()) count as
 * missing. Bare lengths (transition hints) are ignored.
 */
function parseStops(
  args: string[],
  lineLength: number,
  parse: ColorParser,
  angular = false
): GradientStop[] | null {
  const colors: RGBA[] = []
  const pos: (number | null)[] = []
  const toFrac = (tok: string): number | null => {
    if (angular) {
      // Conic: angles (a turn = 1) or percentages.
      const a = parseAngle(tok)
      if (a != null) {
        return a / (2 * Math.PI)
      }
      return tok.endsWith('%') ? Number.parseFloat(tok) / 100 : null
    }
    const l = parseLen(tok)
    if (!l) {
      return null
    }
    if (l.pct) {
      return l.value / 100
    }
    return lineLength > 0 ? l.value / lineLength : 0
  }
  for (const arg of args) {
    if (arg === '') {
      return null
    }
    // Transition hint: a lone length between two colours. Ignored.
    if (parseLen(arg) || (angular && parseAngle(arg) != null)) {
      continue
    }
    const { color, positions } = splitStop(arg)
    const c = parse(color)
    if (positions.length === 0) {
      colors.push(c)
      pos.push(null)
    }
    for (const p of positions.slice(0, 2)) {
      colors.push(c)
      pos.push(toFrac(p))
    }
  }
  if (colors.length < 2) {
    return null
  }
  const fixed = fixupPositions(pos)
  let stops: GradientStop[] = colors.map((color, i) => ({
    color,
    pos: fixed[i] ?? 0
  }))
  if (stops.length > MAX_STOPS) {
    stops = downsample(stops)
  }
  return stops
}

/**
 * CSS stop fix-up: first defaults to 0 and last to 1, a position smaller
 * than any before it is raised to that maximum, and runs of missing
 * positions are spread evenly between their defined neighbours.
 */
export function fixupPositions(pos: (number | null)[]): number[] {
  const p = pos.slice()
  const n = p.length
  if (n === 0) {
    return []
  }
  if (p[0] == null) {
    p[0] = 0
  }
  if (p[n - 1] == null) {
    p[n - 1] = 1
  }
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < n; i++) {
    const v = p[i]
    if (v == null) {
      continue
    }
    max = Math.max(max, v)
    p[i] = max
  }
  let i = 0
  while (i < n) {
    if (p[i] != null) {
      i++
      continue
    }
    let j = i
    while (j < n && p[j] == null) {
      j++
    }
    // p[i-1] and p[j] are defined (ends were defaulted above).
    const a = p[i - 1] ?? 0
    const b = p[j] ?? a
    const span = j - i + 1
    for (let k = i; k < j; k++) {
      p[k] = a + ((b - a) * (k - i + 1)) / span
    }
    i = j
  }
  return p.map((v) => v ?? 0)
}

/** Keep the first and last stop; sample the rest at evenly spaced indices. */
function downsample(stops: GradientStop[]): GradientStop[] {
  const out: GradientStop[] = []
  const last = stops.length - 1
  for (let k = 0; k < MAX_STOPS; k++) {
    const s = stops[Math.round((k * last) / (MAX_STOPS - 1))]
    if (s) {
      out.push(s)
    }
  }
  return out
}

const INTERPOLATION_RE =
  /(^|\s)in\s+[a-z][a-z0-9-]*(\s+(shorter|longer|increasing|decreasing)\s+hue)?(?=\s|$)/i

/**
 * Drop a `in <colorspace> [<hue-interpolation> hue]` clause from the
 * gradient's first argument (removing the argument when nothing else is
 * left). Approximation: stops are still interpolated in sRGB.
 */
function stripInterpolation(args: string[]): string[] {
  const head = args[0]
  if (head === undefined || !INTERPOLATION_RE.test(head)) {
    return args
  }
  const rest = head.replace(INTERPOLATION_RE, ' ').trim()
  return rest ? [rest, ...args.slice(1)] : args.slice(1)
}

function parseLinear(
  all: string[],
  rect: Rect,
  parse: ColorParser
): Gradient | null {
  const args = stripInterpolation(all)
  let angle = Math.PI // default: to bottom
  let rest = args
  const head = (args[0] ?? '').toLowerCase()
  const words = head.split(/\s+/)
  if (words[0] === 'to') {
    const a = parseToKeywords(words.slice(1), rect)
    if (a == null) {
      return null
    }
    angle = a
    rest = args.slice(1)
  } else {
    const a = parseAngle(head)
    if (a != null) {
      angle = a
      rest = args.slice(1)
    }
  }
  const len =
    Math.abs(rect.width * Math.sin(angle)) +
    Math.abs(rect.height * Math.cos(angle))
  const stops = parseStops(rest, len, parse)
  if (!stops) {
    return null
  }
  return { kind: 'linear', angle, center: [0.5, 0.5], radii: [0, 0], stops }
}

const SHAPES = new Set(['circle', 'ellipse'])
const SIZES = new Set([
  'closest-side',
  'farthest-side',
  'closest-corner',
  'farthest-corner'
])

/** Whether a radial gradient's first argument is a shape/size/position. */
function isRadialPrelude(arg: string): boolean {
  const first = arg.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return (
    SHAPES.has(first) || SIZES.has(first) || first === 'at' || !!parseLen(first)
  )
}

const H_KEYS: Record<string, number> = { left: 0, center: 0.5, right: 1 }
const V_KEYS: Record<string, number> = { top: 0, center: 0.5, bottom: 1 }

/**
 * `at` position (1 or 2 values: keywords, % or px) -> centre in box px.
 * 3/4-value edge-offset syntax is not supported (returns null).
 */
function parsePosition(toks: string[], rect: Rect): [number, number] | null {
  if (toks.length === 0) {
    return [rect.width / 2, rect.height / 2]
  }
  if (toks.length > 2) {
    return null
  }
  let [a, b] = toks as [string, string | undefined]
  b ??= 'center'
  // Keyword pairs may come vertical-first (`top left`).
  if (a in V_KEYS && !(a in H_KEYS)) {
    ;[a, b] = [b, a]
  } else if (b in H_KEYS && !(b in V_KEYS)) {
    ;[a, b] = [b, a]
  }
  const res = (tok: string, keys: Record<string, number>, size: number) => {
    const k = keys[tok]
    if (k != null) {
      return k * size
    }
    const l = parseLen(tok)
    if (!l) {
      return null
    }
    return l.pct ? (l.value / 100) * size : l.value
  }
  const x = res(a, H_KEYS, rect.width)
  const y = res(b, V_KEYS, rect.height)
  if (x == null || y == null) {
    return null
  }
  return [x, y]
}

function parseRadial(
  all: string[],
  rect: Rect,
  parse: ColorParser
): Gradient | null {
  const args = stripInterpolation(all)
  let rest = args
  let shape = ''
  let size = 'farthest-corner'
  const lens: Len[] = []
  let posToks: string[] = []
  const head = args[0] ?? ''
  if (isRadialPrelude(head)) {
    rest = args.slice(1)
    const toks = head.toLowerCase().trim().split(/\s+/)
    const at = toks.indexOf('at')
    const pre = at >= 0 ? toks.slice(0, at) : toks
    posToks = at >= 0 ? toks.slice(at + 1) : []
    for (const t of pre) {
      if (SHAPES.has(t)) {
        shape = t
      } else if (SIZES.has(t)) {
        size = t
      } else {
        const l = parseLen(t)
        if (!l) {
          return null
        }
        lens.push(l)
      }
    }
    if (lens.length > 2) {
      return null
    }
  }
  if (shape === '') {
    shape = lens.length === 1 ? 'circle' : 'ellipse'
  }

  const c = parsePosition(posToks, rect)
  if (!c) {
    return null
  }
  const [cx, cy] = c
  const w = rect.width
  const h = rect.height
  const dx = [Math.abs(cx), Math.abs(w - cx)]
  const dy = [Math.abs(cy), Math.abs(h - cy)]
  const sx = { min: Math.min(...dx), max: Math.max(...dx) }
  const sy = { min: Math.min(...dy), max: Math.max(...dy) }

  let rx: number
  let ry: number
  if (lens.length > 0) {
    const l0 = lens[0] as Len
    const l1 = lens[1] ?? l0
    rx = l0.pct ? (l0.value / 100) * w : l0.value
    ry = l1.pct ? (l1.value / 100) * h : l1.value
    if (shape === 'circle') {
      ry = rx
    }
  } else if (shape === 'circle') {
    let r: number
    if (size === 'closest-side') {
      r = Math.min(sx.min, sy.min)
    } else if (size === 'farthest-side') {
      r = Math.max(sx.max, sy.max)
    } else if (size === 'closest-corner') {
      r = Math.hypot(sx.min, sy.min)
    } else {
      r = Math.hypot(sx.max, sy.max)
    }
    rx = r
    ry = r
  } else if (size === 'closest-side' || size === 'farthest-side') {
    const k = size === 'closest-side' ? 'min' : 'max'
    rx = sx[k]
    ry = sy[k]
  } else {
    // Corner sizes: the ellipse with the matching *-side aspect ratio that
    // passes through that corner, which scales both side radii by √2.
    const k = size === 'closest-corner' ? 'min' : 'max'
    rx = sx[k] * Math.SQRT2
    ry = sy[k] * Math.SQRT2
  }
  // Degenerate radii are nudged off zero; the shader also guards the divide.
  rx = Math.max(rx, 1e-3)
  ry = Math.max(ry, 1e-3)

  const stops = parseStops(rest, rx, parse)
  if (!stops) {
    return null
  }
  return {
    kind: 'radial',
    angle: 0,
    center: [w > 0 ? cx / w : 0.5, h > 0 ? cy / h : 0.5],
    radii: [rx, ry],
    stops
  }
}

/** `conic-gradient([from <angle>] [at <position>], <stops>)`. */
function parseConic(
  all: string[],
  rect: Rect,
  parse: ColorParser
): Gradient | null {
  const args = stripInterpolation(all)
  let rest = args
  let angle = 0
  let center: [number, number] = [rect.width / 2, rect.height / 2]
  const head = (args[0] ?? '').toLowerCase().trim()
  if (head.startsWith('from ') || head.startsWith('at ')) {
    rest = args.slice(1)
    const toks = head.split(/\s+/)
    const at = toks.indexOf('at')
    const pre = at >= 0 ? toks.slice(0, at) : toks
    if (pre[0] === 'from') {
      const a = parseAngle(pre[1] ?? '')
      if (a == null) {
        return null
      }
      angle = a
    }
    if (at >= 0) {
      const p = parsePosition(toks.slice(at + 1), rect)
      if (!p) {
        return null
      }
      center = p
    }
  }
  const stops = parseStops(rest, 1, parse, true)
  if (!stops) {
    return null
  }
  const w = rect.width
  const h = rect.height
  return {
    kind: 'conic',
    angle,
    center: [w > 0 ? center[0] / w : 0.5, h > 0 ? center[1] / h : 0.5],
    radii: [1, 1],
    stops
  }
}

/**
 * Parse one computed `background-image` layer into a Gradient resolved
 * against `rect` (the gradient box), or null when it isn't a supported
 * gradient (url(), conic-*, malformed, < 2 stops). `repeating-*` set
 * `repeating`: the stops repeat beyond the last one. A
 * colour-interpolation clause (`in oklab`) is accepted but ignored: stops
 * are interpolated in sRGB, an approximation.
 */
export function parseGradient(
  layer: string,
  rect: Rect,
  parse: ColorParser = parseColor
): Gradient | null {
  const m = /^([a-z-]+)\(([\s\S]*)\)$/i.exec(layer.trim())
  if (!m) {
    return null
  }
  let fn = (m[1] ?? '').toLowerCase()
  const repeating = fn.startsWith('repeating-')
  if (repeating) {
    fn = fn.slice('repeating-'.length)
  }
  const args = splitTopLevel(m[2] ?? '', ',')
  const g =
    fn === 'linear-gradient'
      ? parseLinear(args, rect, parse)
      : fn === 'radial-gradient'
        ? parseRadial(args, rect, parse)
        : fn === 'conic-gradient'
          ? parseConic(args, rect, parse)
          : null
  if (g && repeating) {
    g.repeating = true
  }
  return g
}
