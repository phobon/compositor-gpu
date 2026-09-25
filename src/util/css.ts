// Small CSS value helpers shared by the readers. Pure, no DOM access.

/**
 * Split a CSS value on `sep` where it occurs outside parentheses and
 * quotes (`rgba(0,0,0,.5)` or `url("a,b")` don't split). A `' '` separator
 * matches any whitespace. Pieces are trimmed; empty pieces are kept so
 * callers can detect them (filter them out where they don't matter).
 */
export function splitTopLevel(value: string, sep: string): string[] {
  const out: string[] = []
  const ws = sep === ' '
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i] as string
    if (quote) {
      if (ch === '\\') {
        i++
      } else if (ch === quote) {
        quote = ''
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && (ws ? /\s/.test(ch) : ch === sep)) {
      out.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(value.slice(start).trim())
  return out
}
