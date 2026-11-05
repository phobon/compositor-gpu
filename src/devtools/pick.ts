// Edit tab helpers (docs/EDITOR.md, E2) that need no live DOM: a short
// selector matching one element, a name to suggest for `data-fx`, and a
// label for lists and outlines.

/** What these helpers read of an element. */
export interface PickNode {
  readonly tagName: string
  readonly id: string
  readonly classList: Iterable<string>
  readonly parentElement: PickNode | null
  readonly children: ArrayLike<PickNode>
  getAttribute(name: string): string | null
}

const IDENT = /^-?[A-Za-z_][\w-]*$/
/** Classes that look generated (CSS modules, styled-components, hashes)
 * don't survive a rebuild. */
const GENERATED = /^(css|sc|jsx|svelte|emotion)-|__|[A-Za-z]*\d{3,}|^_/

const stableClasses = (n: PickNode): string[] =>
  [...n.classList].filter((c) => IDENT.test(c) && !GENERATED.test(c))

const segment = (n: PickNode): string => {
  const tag = n.tagName.toLowerCase()
  let seg =
    tag +
    stableClasses(n)
      .slice(0, 2)
      .map((c) => `.${c}`)
      .join('')
  const p = n.parentElement
  if (p) {
    const same = Array.from(p.children).filter((c) => c.tagName === n.tagName)
    if (same.length > 1) {
      seg += `:nth-of-type(${same.indexOf(n) + 1})`
    }
  }
  return seg
}

/**
 * A selector matching `el` alone (`count(sel)` tells how many elements
 * one matches), walking up until it is unique: an id or `data-fx`
 * ancestor anchors it, else it grows toward `body`.
 */
export function selectorFor(
  el: PickNode,
  count: (sel: string) => number
): string {
  const parts: string[] = []
  for (let n: PickNode | null = el; n; n = n.parentElement) {
    const tag = n.tagName.toLowerCase()
    const fx = n.getAttribute('data-fx')
    if (n.id && IDENT.test(n.id)) {
      parts.unshift(`#${n.id}`)
    } else if (fx && !/["\\]/.test(fx)) {
      parts.unshift(`[data-fx="${fx}"]`)
    } else if (tag === 'html') {
      break
    } else {
      parts.unshift(tag === 'body' ? 'body' : segment(n))
    }
    const sel = parts.join(' > ')
    if (tag === 'body' || count(sel) === 1) {
      return sel
    }
  }
  return parts.join(' > ')
}

const slug = (s: string): string =>
  s
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** A `data-fx` name for `el` from its id, first stable class or tag. */
export function suggestName(el: PickNode): string {
  const own = el.getAttribute('data-fx')
  if (own) {
    return own
  }
  const base =
    (el.id && slug(el.id)) ||
    slug(stableClasses(el)[0] ?? '') ||
    el.tagName.toLowerCase()
  return base || 'element'
}

/** `tag#id.class.class` or `tag[data-fx=name]`, at most `max` chars. */
export function labelOf(el: PickNode, max = 48): string {
  const tag = el.tagName.toLowerCase()
  const fx = el.getAttribute('data-fx')
  const s = fx
    ? `${tag}[data-fx=${fx}]`
    : tag +
      (el.id ? `#${el.id}` : '') +
      [...el.classList]
        .slice(0, 2)
        .map((c) => `.${c}`)
        .join('')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
