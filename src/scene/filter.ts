// CSS `filter` on a stacking context, reduced to what the group composite
// applies: a colour matrix per colour function (brightness, contrast,
// grayscale, hue-rotate, invert, opacity, saturate, sepia), applied in
// order with the clamp to [0, 1] after each, and a Gaussian blur. The
// matrices are the Filter Effects spec's, in sRGB as Chrome applies the
// shorthand functions. Deviations: the colour functions apply after the
// blur whatever their order in the list; drop shadows apply after the
// blur and before the colour functions (so a colour function listed
// before a drop-shadow tints its shadow too); past MAX_FILTER_OPS colour
// functions the rest are dropped; `url()` is not drawn (logged once).
import { tryParseColor } from '../util/color'
import { log } from '../util/log'

/** A 4×5 colour matrix, row-major: rows r, g, b, a of [r g b a offset],
 * applied to unpremultiplied colour. */
export type ColorMatrix = number[]

/** Colour functions applied per group (gpu/composite.ts). */
export const MAX_FILTER_OPS = 8

export interface GroupFilter {
  /** The colour functions in order, one matrix each (identities
   * dropped); empty when there are none. */
  matrices: ColorMatrix[]
  /** Gaussian standard deviation, CSS px (0: none). Several blurs combine
   * as the root of the sum of squares. */
  blur: number
  /** `drop-shadow()`s in order, each the shadow of everything before it
   * (the content and earlier shadows). */
  shadows: DropShadow[]
}

/** One `drop-shadow()`: the group's alpha, offset, blurred and tinted,
 * drawn under it. */
export interface DropShadow {
  /** Offset, CSS px in the element's own (untransformed) space. */
  dx: number
  dy: number
  /** Gaussian standard deviation, CSS px (half the blur radius). */
  sigma: number
  /** sRGB, straight alpha, 0..1. */
  color: [number, number, number, number]
}

const IDENTITY: ColorMatrix = [
  1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0
]

/** An rgb 3×3 (row-major) as a 4×5 matrix leaving alpha alone. */
function rgb3(m: number[], offset = 0): ColorMatrix {
  return [
    m[0] ?? 0,
    m[1] ?? 0,
    m[2] ?? 0,
    0,
    offset,
    m[3] ?? 0,
    m[4] ?? 0,
    m[5] ?? 0,
    0,
    offset,
    m[6] ?? 0,
    m[7] ?? 0,
    m[8] ?? 0,
    0,
    offset,
    0,
    0,
    0,
    1,
    0
  ]
}

function amount(arg: string, fallback: number): number {
  const v = arg.trim()
  if (v === '') {
    return fallback
  }
  const n = Number.parseFloat(v)
  if (!Number.isFinite(n)) {
    return fallback
  }
  return v.endsWith('%') ? n / 100 : n
}

function angle(arg: string): number {
  const v = arg.trim()
  const n = Number.parseFloat(v)
  if (!Number.isFinite(n)) {
    return 0
  }
  if (v.endsWith('grad')) {
    return (n * Math.PI) / 200
  }
  if (v.endsWith('rad')) {
    return n
  }
  if (v.endsWith('turn')) {
    return n * 2 * Math.PI
  }
  return (n * Math.PI) / 180
}

const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1)

function colorOp(name: string, arg: string): ColorMatrix | null {
  switch (name) {
    case 'brightness': {
      const a = Math.max(0, amount(arg, 1))
      return rgb3([a, 0, 0, 0, a, 0, 0, 0, a])
    }
    case 'contrast': {
      const a = Math.max(0, amount(arg, 1))
      return rgb3([a, 0, 0, 0, a, 0, 0, 0, a], 0.5 - 0.5 * a)
    }
    case 'invert': {
      const a = clamp01(amount(arg, 1))
      const k = 1 - 2 * a
      return rgb3([k, 0, 0, 0, k, 0, 0, 0, k], a)
    }
    case 'opacity': {
      const a = clamp01(amount(arg, 1))
      const m = IDENTITY.slice()
      m[18] = a
      return m
    }
    case 'grayscale': {
      const s = 1 - clamp01(amount(arg, 1))
      return rgb3([
        0.2126 + 0.7874 * s,
        0.7152 - 0.7152 * s,
        0.0722 - 0.0722 * s,
        0.2126 - 0.2126 * s,
        0.7152 + 0.2848 * s,
        0.0722 - 0.0722 * s,
        0.2126 - 0.2126 * s,
        0.7152 - 0.7152 * s,
        0.0722 + 0.9278 * s
      ])
    }
    case 'sepia': {
      const s = 1 - clamp01(amount(arg, 1))
      return rgb3([
        0.393 + 0.607 * s,
        0.769 - 0.769 * s,
        0.189 - 0.189 * s,
        0.349 - 0.349 * s,
        0.686 + 0.314 * s,
        0.168 - 0.168 * s,
        0.272 - 0.272 * s,
        0.534 - 0.534 * s,
        0.131 + 0.869 * s
      ])
    }
    case 'saturate': {
      const s = Math.max(0, amount(arg, 1))
      return rgb3([
        0.213 + 0.787 * s,
        0.715 - 0.715 * s,
        0.072 - 0.072 * s,
        0.213 - 0.213 * s,
        0.715 + 0.285 * s,
        0.072 - 0.072 * s,
        0.213 - 0.213 * s,
        0.715 - 0.715 * s,
        0.072 + 0.928 * s
      ])
    }
    case 'hue-rotate': {
      const t = angle(arg)
      const c = Math.cos(t)
      const s = Math.sin(t)
      return rgb3([
        0.213 + c * 0.787 - s * 0.213,
        0.715 - c * 0.715 - s * 0.715,
        0.072 - c * 0.072 + s * 0.928,
        0.213 - c * 0.213 + s * 0.143,
        0.715 + c * 0.285 + s * 0.14,
        0.072 - c * 0.072 - s * 0.283,
        0.213 - c * 0.213 - s * 0.787,
        0.715 - c * 0.715 + s * 0.715,
        0.072 + c * 0.928 + s * 0.072
      ])
    }
    default:
      return null
  }
}

/** Top-level `name(args)` functions of a filter list. */
function functions(value: string): [string, string][] {
  const out: [string, string][] = []
  let i = 0
  while (i < value.length) {
    const open = value.indexOf('(', i)
    if (open === -1) {
      break
    }
    const name = value.slice(i, open).trim().toLowerCase()
    let depth = 1
    let j = open + 1
    while (j < value.length && depth > 0) {
      const ch = value[j]
      if (ch === '(') {
        depth++
      } else if (ch === ')') {
        depth--
      }
      j++
    }
    out.push([name, value.slice(open + 1, j - 1)])
    i = j
  }
  return out
}

const LENGTH = /^-?(\d+\.?\d*|\.\d+)(e-?\d+)?(px)?$/i

/** Space-separated tokens of `s` outside parentheses. */
function tokens(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s.trim()) {
    if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth--
    }
    if (ch === ' ' && depth === 0) {
      if (cur) {
        out.push(cur)
      }
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur) {
    out.push(cur)
  }
  return out
}

/** A computed `drop-shadow()` argument (`<color>? <dx> <dy> <blur>?`, in
 * either order), or null when it has no offsets or draws nothing. */
function dropShadow(arg: string): DropShadow | null {
  const lens: number[] = []
  let color = 'currentcolor'
  for (const t of tokens(arg)) {
    if (LENGTH.test(t)) {
      lens.push(Number.parseFloat(t))
    } else {
      color = t
    }
  }
  if (lens.length < 2) {
    return null
  }
  const c = tryParseColor(color)
  if (!c || c.a <= 0) {
    return null
  }
  return {
    dx: lens[0] ?? 0,
    dy: lens[1] ?? 0,
    sigma: Math.max(0, lens[2] ?? 0) / 2,
    color: [c.r, c.g, c.b, c.a]
  }
}

const warned = new Set<string>()

const isIdentity = (m: ColorMatrix): boolean =>
  m.every((v, i) => Math.abs(v - (IDENTITY[i] ?? 0)) < 1e-6)

/** The group filter for a computed `filter` value, or null for none (or
 * nothing drawable). */
export function parseFilter(value: string): GroupFilter | null {
  if (!value || value === 'none') {
    return null
  }
  const matrices: ColorMatrix[] = []
  const shadows: DropShadow[] = []
  let blur2 = 0
  for (const [name, arg] of functions(value)) {
    if (name === 'drop-shadow') {
      const sh = dropShadow(arg)
      if (sh) {
        shadows.push(sh)
      }
      continue
    }
    if (name === 'blur') {
      const px = Number.parseFloat(arg)
      if (Number.isFinite(px) && px > 0) {
        blur2 += px * px
      }
      continue
    }
    const op = colorOp(name, arg)
    if (op) {
      if (isIdentity(op)) {
        continue
      }
      if (matrices.length < MAX_FILTER_OPS) {
        matrices.push(op)
      } else if (!warned.has('max')) {
        warned.add('max')
        log.warn(`filter: more than ${MAX_FILTER_OPS} colour functions`)
      }
      continue
    }
    if (!warned.has(name)) {
      warned.add(name)
      log.warn(`filter: ${name}() is not drawn`)
    }
  }
  const blur = Math.sqrt(blur2)
  return matrices.length > 0 || blur > 0 || shadows.length > 0
    ? { matrices, blur, shadows }
    : null
}

/** How far a filter spreads paint beyond its group's records, CSS px. */
export function filterSpread(f: GroupFilter | null | undefined): number {
  if (!f) {
    return 0
  }
  // Each shadow is a shadow of everything before it, so their reaches add.
  let s = f.blur * 3
  for (const sh of f.shadows) {
    s += Math.max(Math.abs(sh.dx), Math.abs(sh.dy)) + sh.sigma * 3
  }
  return Math.ceil(s)
}
