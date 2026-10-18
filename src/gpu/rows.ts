// Device-px and CSS-px row intervals [y0, y1), and full-width rects
// (x, y, w, h) over them: pure helpers for the fill planner and the
// renderer.

/** The rows spanning two full-width device-px rects (x, y, w, h). */
export function hullRows(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number]
): [number, number, number, number] {
  const y0 = Math.min(a[1], b[1])
  const y1 = Math.max(a[1] + a[3], b[1] + b[3])
  return [a[0], y0, Math.max(a[2], b[2]), y1 - y0]
}

/** Rows [y0, y1) not covered by `cover` (disjoint, in order). */
export function rowsMissing(
  y0: number,
  y1: number,
  cover: readonly (readonly [number, number])[]
): [number, number][] {
  const out: [number, number][] = []
  let y = y0
  for (const [a, b] of cover) {
    if (b <= y) {
      continue
    }
    if (a >= y1) {
      break
    }
    if (a > y) {
      out.push([y, a])
    }
    y = Math.max(y, b)
    if (y >= y1) {
      break
    }
  }
  if (y < y1) {
    out.push([y, y1])
  }
  return out
}

/** `list` with [y0, y1) added, merged (disjoint, in order). */
export function addRows(
  list: readonly (readonly [number, number])[],
  y0: number,
  y1: number
): [number, number][] {
  const all: [number, number][] = [
    ...list.map((r) => [r[0], r[1]] as [number, number]),
    [y0, y1]
  ]
  all.sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const iv of all) {
    const last = out[out.length - 1]
    if (last && iv[0] <= last[1]) {
      last[1] = Math.max(last[1], iv[1])
    } else if (iv[1] > iv[0]) {
      out.push(iv)
    }
  }
  return out
}

/** Intersection of two device-px rects (x, y, w, h); w or h 0 when they
 * don't meet. */
export function meet(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number]
): [number, number, number, number] {
  const x = Math.max(a[0], b[0])
  const y = Math.max(a[1], b[1])
  const w = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - x)
  const h = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - y)
  return [x, y, w, h]
}

export function clamp(v: number, max: number): number {
  return Math.min(Math.max(v, 0), max)
}
