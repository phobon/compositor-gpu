// Svg geometry as plain numbers (M5b, M5f): path data parsed, and the
// basic shapes outlined, into a PathSink. The runtime's sink flattens to
// line segments at the on-screen scale (dom/svg_paths.ts, Flat); the bake
// tool's records the calls as a tape (TapeSink), which replayTape plays
// back into a Flat later, call for call, so a baked svg flattens exactly
// as parsing it would. Pure: no DOM.

/** What path data and shapes are outlined into. Coordinates are user
 * space; `arc` takes the centre form (the start point is not pushed). */
export interface PathSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadTo(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): void
  cubicTo(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number
  ): void
  arc(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    phi: number,
    a0: number,
    sweep: number
  ): void
  /** Close (or leave open) the current subpath. */
  end(closed: boolean): void
}

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y

/** Flatten an svg path `d` into `f`. Malformed data stops at the error,
 * as browsers do. */
export function flattenPathData(d: string, f: PathSink): void {
  let i = 0
  const skip = (): void => {
    while (i < d.length && /[\s,]/.test(d[i] ?? '')) {
      i++
    }
  }
  const num = (): number | null => {
    skip()
    NUM.lastIndex = i
    const m = NUM.exec(d)
    if (!m) {
      return null
    }
    i = NUM.lastIndex
    return Number(m[0])
  }
  const flag = (): number | null => {
    skip()
    const c = d[i]
    if (c === '0' || c === '1') {
      i++
      return c === '1' ? 1 : 0
    }
    return null
  }
  const nums = (n: number): number[] | null => {
    const out: number[] = []
    for (let k = 0; k < n; k++) {
      const v = num()
      if (v === null) {
        return null
      }
      out.push(v)
    }
    return out
  }
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  // Reflection points for S and T.
  let cx = 0
  let cy = 0
  let qx = 0
  let qy = 0
  let prev = ''
  let cmd = ''
  for (;;) {
    skip()
    if (i >= d.length) {
      break
    }
    const c = d[i] ?? ''
    if (/[a-zA-Z]/.test(c)) {
      cmd = c
      i++
    } else if (!cmd || cmd === 'z' || cmd === 'Z') {
      break
    }
    const rel = cmd === cmd.toLowerCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    switch (cmd.toUpperCase()) {
      case 'M': {
        const v = nums(2)
        if (!v) {
          return
        }
        x = ox + (v[0] ?? 0)
        y = oy + (v[1] ?? 0)
        sx = x
        sy = y
        f.moveTo(x, y)
        // Further pairs are implicit linetos.
        cmd = rel ? 'l' : 'L'
        break
      }
      case 'L': {
        const v = nums(2)
        if (!v) {
          return
        }
        x = ox + (v[0] ?? 0)
        y = oy + (v[1] ?? 0)
        f.lineTo(x, y)
        break
      }
      case 'H': {
        const v = num()
        if (v === null) {
          return
        }
        x = ox + v
        f.lineTo(x, y)
        break
      }
      case 'V': {
        const v = num()
        if (v === null) {
          return
        }
        y = oy + v
        f.lineTo(x, y)
        break
      }
      case 'C':
      case 'S': {
        const s = cmd.toUpperCase() === 'S'
        const v = nums(s ? 4 : 6)
        if (!v) {
          return
        }
        let x1: number
        let y1: number
        let k = 0
        if (s) {
          const smooth = /[CcSs]/.test(prev)
          x1 = smooth ? 2 * x - cx : x
          y1 = smooth ? 2 * y - cy : y
        } else {
          x1 = ox + (v[k++] ?? 0)
          y1 = oy + (v[k++] ?? 0)
        }
        const x2 = ox + (v[k++] ?? 0)
        const y2 = oy + (v[k++] ?? 0)
        const x3 = ox + (v[k++] ?? 0)
        const y3 = oy + (v[k++] ?? 0)
        f.lineTo(x, y)
        f.cubicTo(x, y, x1, y1, x2, y2, x3, y3)
        cx = x2
        cy = y2
        x = x3
        y = y3
        break
      }
      case 'Q':
      case 'T': {
        const t = cmd.toUpperCase() === 'T'
        const v = nums(t ? 2 : 4)
        if (!v) {
          return
        }
        let x1: number
        let y1: number
        let k = 0
        if (t) {
          const smooth = /[QqTt]/.test(prev)
          x1 = smooth ? 2 * x - qx : x
          y1 = smooth ? 2 * y - qy : y
        } else {
          x1 = ox + (v[k++] ?? 0)
          y1 = oy + (v[k++] ?? 0)
        }
        const x2 = ox + (v[k++] ?? 0)
        const y2 = oy + (v[k++] ?? 0)
        f.lineTo(x, y)
        f.quadTo(x, y, x1, y1, x2, y2)
        qx = x1
        qy = y1
        x = x2
        y = y2
        break
      }
      case 'A': {
        const r = nums(3)
        const large = r ? flag() : null
        const sweep = large !== null ? flag() : null
        const end = sweep !== null ? nums(2) : null
        if (!r || large === null || sweep === null || !end) {
          return
        }
        const x2 = ox + (end[0] ?? 0)
        const y2 = oy + (end[1] ?? 0)
        f.lineTo(x, y)
        arcTo(f, x, y, r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, large, sweep, x2, y2)
        x = x2
        y = y2
        break
      }
      case 'Z': {
        f.end(true)
        x = sx
        y = sy
        break
      }
      default:
        return
    }
    prev = cmd
  }
  f.end(false)
}

/** SVG elliptical arc (endpoint form, SVG 1.1 F.6.5) from (x1, y1). */
export function arcTo(
  f: PathSink,
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  angle: number,
  large: number,
  sweep: number,
  x2: number,
  y2: number
): void {
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if ((x1 === x2 && y1 === y2) || rx === 0 || ry === 0) {
    f.lineTo(x2, y2)
    return
  }
  const phi = (angle * Math.PI) / 180
  const cp = Math.cos(phi)
  const sp = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cp * dx + sp * dy
  const y1p = -sp * dx + cp * dy
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) {
    const k = Math.sqrt(lam)
    rx *= k
    ry *= k
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  let co = Math.sqrt(Math.max(0, num / den))
  if (large === sweep) {
    co = -co
  }
  const cxp = (co * rx * y1p) / ry
  const cyp = (-co * ry * x1p) / rx
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2
  const cy = sp * cxp + cp * cyp + (y1 + y2) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    return a
  }
  const a0 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let da = ang(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry
  )
  if (!sweep && da > 0) {
    da -= 2 * Math.PI
  } else if (sweep && da < 0) {
    da += 2 * Math.PI
  }
  f.arc(cx, cy, rx, ry, phi, a0, da)
}

// --- Shapes ----------------------------------------------------------------

/** A rect; rx / ry already resolved (an absent one takes the other's
 * value) and the caller skips non-positive sizes. */
export function rectPath(
  f: PathSink,
  x: number,
  y: number,
  w: number,
  h: number,
  rxIn: number,
  ryIn: number
): void {
  if (w <= 0 || h <= 0) {
    return
  }
  const rx = Math.min(Math.max(rxIn, 0), w / 2)
  const ry = Math.min(Math.max(ryIn, 0), h / 2)
  if (rx <= 0 || ry <= 0) {
    f.moveTo(x, y)
    f.lineTo(x + w, y)
    f.lineTo(x + w, y + h)
    f.lineTo(x, y + h)
    f.end(true)
    return
  }
  const q = Math.PI / 2
  f.moveTo(x + rx, y)
  f.lineTo(x + w - rx, y)
  f.arc(x + w - rx, y + ry, rx, ry, 0, -q, q)
  f.lineTo(x + w, y + h - ry)
  f.arc(x + w - rx, y + h - ry, rx, ry, 0, 0, q)
  f.lineTo(x + rx, y + h)
  f.arc(x + rx, y + h - ry, rx, ry, 0, q, q)
  f.lineTo(x, y + ry)
  f.arc(x + rx, y + ry, rx, ry, 0, Math.PI, q)
  f.end(true)
}

/** A circle or ellipse. */
export function ellipsePath(
  f: PathSink,
  cx: number,
  cy: number,
  rx: number,
  ry: number
): void {
  if (rx <= 0 || ry <= 0) {
    return
  }
  f.moveTo(cx + rx, cy)
  f.arc(cx, cy, rx, ry, 0, 0, 2 * Math.PI)
  f.end(true)
}

/** A line, polyline or polygon from x y pairs. */
export function polyPath(
  f: PathSink,
  pts: readonly number[],
  closed: boolean
): void {
  for (let k = 0; k + 1 < pts.length; k += 2) {
    if (k === 0) {
      f.moveTo(pts[0] ?? 0, pts[1] ?? 0)
    } else {
      f.lineTo(pts[k] ?? 0, pts[k + 1] ?? 0)
    }
  }
  f.end(closed)
}

/** A polyline / polygon `points` attribute as x y pairs (an odd last
 * number is dropped, as browsers do). */
export function parsePoints(s: string): number[] {
  const out: number[] = []
  const re = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g
  for (const m of s.matchAll(re)) {
    out.push(Number(m[0]))
  }
  if (out.length % 2 === 1) {
    out.pop()
  }
  return out
}

// --- Tapes -----------------------------------------------------------------

/** Tape opcodes, each followed by its arguments. */
const OP_MOVE = 0
const OP_LINE = 1
const OP_QUAD = 2
const OP_CUBIC = 3
const OP_ARC = 4
const OP_END = 5
const ARGS = [2, 2, 6, 8, 7, 1]

/** Records sink calls as numbers (opcode, arguments)*. */
export class TapeSink implements PathSink {
  readonly ops: number[] = []
  moveTo(x: number, y: number): void {
    this.ops.push(OP_MOVE, x, y)
  }
  lineTo(x: number, y: number): void {
    this.ops.push(OP_LINE, x, y)
  }
  quadTo(...a: [number, number, number, number, number, number]): void {
    this.ops.push(OP_QUAD, ...a)
  }
  cubicTo(
    ...a: [number, number, number, number, number, number, number, number]
  ): void {
    this.ops.push(OP_CUBIC, ...a)
  }
  arc(...a: [number, number, number, number, number, number, number]): void {
    this.ops.push(OP_ARC, ...a)
  }
  end(closed: boolean): void {
    this.ops.push(OP_END, closed ? 1 : 0)
  }
}

/** Play `tape[start, end)` (TapeSink's ops) into `f`. Throws on a bad
 * opcode. */
export function replayTape(
  tape: ArrayLike<number>,
  f: PathSink,
  start = 0,
  end = tape.length
): void {
  const a = (k: number): number => tape[k] ?? 0
  let i = start
  while (i < end) {
    const op = a(i)
    const n = ARGS[op]
    if (n === undefined || i + 1 + n > end) {
      throw new Error(`bad path tape opcode ${op} at ${i}`)
    }
    const p = i + 1
    switch (op) {
      case OP_MOVE:
        f.moveTo(a(p), a(p + 1))
        break
      case OP_LINE:
        f.lineTo(a(p), a(p + 1))
        break
      case OP_QUAD:
        f.quadTo(a(p), a(p + 1), a(p + 2), a(p + 3), a(p + 4), a(p + 5))
        break
      case OP_CUBIC:
        f.cubicTo(
          a(p),
          a(p + 1),
          a(p + 2),
          a(p + 3),
          a(p + 4),
          a(p + 5),
          a(p + 6),
          a(p + 7)
        )
        break
      case OP_ARC:
        f.arc(a(p), a(p + 1), a(p + 2), a(p + 3), a(p + 4), a(p + 5), a(p + 6))
        break
      default:
        f.end(a(p) === 1)
    }
    i = p + n
  }
}
