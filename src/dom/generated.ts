// CSS counters and quote depth for generated content (`counter()`,
// `counters()`, `open-quote` / `close-quote`), which depend on everything
// before a pseudo-element in tree order. Computed by one walk of the
// document per read, run only when some pseudo-element's content needs it
// (GeneratedState.at), following CSS Lists 3 and CSS Content 3 in
// simplified form:
//
// - `counter-reset` makes a new counter scoped to the element, its
//   descendants and its following siblings; `counter-increment` and
//   `counter-set` act on the innermost counter of that name, creating one
//   at the element when there is none. A `display: list-item` element
//   increments `list-item` unless it names it; `ol` / `ul` / `menu` reset
//   it (`start` and `reversed` are not applied: ::marker text has its own
//   ordinal in pseudo.ts).
// - A pseudo-element's counter properties apply where it sits: ::marker
//   and ::before after the element's own, ::after after its children.
// - Quote depth goes up at each `open-quote` / `no-open-quote` and down at
//   each `close-quote` / `no-close-quote`, through the whole document.
// - `display: none` elements and their subtrees are skipped. Shadow trees
//   are not walked.

export type PseudoKind = '::marker' | '::before' | '::after'

/** Counters in scope (each name's values, outermost first) and the quote
 * depth where a pseudo-element's content starts. */
export interface GeneratedAt {
  counters: ReadonlyMap<string, readonly number[]>
  quoteDepth: number
}

interface Instance {
  value: number
  /** The element whose children's walk this counter's scope ends with. */
  scope: Element | null
}

const NEEDS = /counter|quote/

/** Does a computed `content` value need counters or quote depth? */
export function needsGenerated(content: string): boolean {
  return NEEDS.test(content)
}

/** Parse `counter-reset` / `-increment` / `-set` into [name, value]
 * pairs; `def` is the value a name without one takes. */
function counterList(value: string, def: number): [string, number][] {
  if (!value || value === 'none') {
    return []
  }
  const out: [string, number][] = []
  const parts = value.trim().split(/\s+/)
  for (let i = 0; i < parts.length; i++) {
    let name = parts[i] ?? ''
    // `reversed(name)` (counter-reset): the start value is not derived.
    const rev = /^reversed\((.*)\)$/.exec(name)
    if (rev) {
      name = rev[1] ?? ''
    }
    const next = parts[i + 1]
    if (next !== undefined && /^[-+]?\d+$/.test(next)) {
      out.push([name, Number.parseInt(next, 10)])
      i++
    } else {
      out.push([name, def])
    }
  }
  return out
}

const LIST_TAGS = new Set(['OL', 'UL', 'MENU'])

/** One read's counters and quote depth at each pseudo-element whose
 * content needs them. The walk runs on the first `at()` of the read. */
export class GeneratedState {
  private snapshots: Map<Element, Map<PseudoKind, GeneratedAt>> | null = null

  /** Forget the last walk (call at the start of every read). */
  clear(): void {
    this.snapshots = null
  }

  /** State where `which` of `el` starts, or a zero state when the walk
   * didn't reach it (outside the document, display: none). */
  at(el: Element, which: PseudoKind): GeneratedAt {
    if (!this.snapshots) {
      this.snapshots = walk()
    }
    return (
      this.snapshots.get(el)?.get(which) ?? {
        counters: new Map(),
        quoteDepth: 0
      }
    )
  }
}

function walk(): Map<Element, Map<PseudoKind, GeneratedAt>> {
  const out = new Map<Element, Map<PseudoKind, GeneratedAt>>()
  const counters = new Map<string, Instance[]>()
  let depth = 0

  const innermost = (name: string, scope: Element | null): Instance => {
    let stack = counters.get(name)
    if (!stack) {
      stack = []
      counters.set(name, stack)
    }
    let inst = stack[stack.length - 1]
    if (!inst) {
      inst = { value: 0, scope }
      stack.push(inst)
    }
    return inst
  }

  const apply = (
    s: CSSStyleDeclaration,
    scope: Element | null,
    listItem: boolean,
    listReset: boolean
  ): void => {
    const resets = counterList(s.counterReset, 0)
    if (listReset && !resets.some(([n]) => n === 'list-item')) {
      resets.push(['list-item', 0])
    }
    for (const [name, value] of resets) {
      let stack = counters.get(name)
      if (!stack) {
        stack = []
        counters.set(name, stack)
      }
      stack.push({ value, scope })
    }
    const incs = counterList(s.counterIncrement, 1)
    if (listItem && !incs.some(([n]) => n === 'list-item')) {
      incs.push(['list-item', 1])
    }
    for (const [name, by] of incs) {
      innermost(name, scope).value += by
    }
    for (const [name, value] of counterList(s.counterSet, 0)) {
      innermost(name, scope).value = value
    }
  }

  const snapshot = (el: Element, which: PseudoKind): void => {
    const counted = new Map<string, number[]>()
    for (const [name, stack] of counters) {
      if (stack.length) {
        counted.set(
          name,
          stack.map((c) => c.value)
        )
      }
    }
    let m = out.get(el)
    if (!m) {
      m = new Map()
      out.set(el, m)
    }
    m.set(which, { counters: counted, quoteDepth: depth })
  }

  const quotes = (content: string): void => {
    for (const q of content.match(/(?:no-)?(?:open|close)-quote/g) ?? []) {
      depth = Math.max(0, depth + (q.endsWith('open-quote') ? 1 : -1))
    }
  }

  const pseudo = (el: Element, which: PseudoKind): void => {
    const ps = getComputedStyle(el, which)
    const content = ps.content
    if (
      which !== '::marker' &&
      (!content || content === 'none' || content === 'normal')
    ) {
      return
    }
    if (ps.display === 'none') {
      return
    }
    apply(ps, el, false, false)
    if (needsGenerated(content)) {
      snapshot(el, which)
    }
    quotes(content)
  }

  const visit = (el: Element): void => {
    const s = getComputedStyle(el)
    if (s.display === 'none') {
      return
    }
    const listItem = s.display === 'list-item'
    apply(s, el.parentElement, listItem, LIST_TAGS.has(el.tagName))
    if (listItem) {
      pseudo(el, '::marker')
    }
    pseudo(el, '::before')
    for (const kid of el.children) {
      visit(kid)
    }
    pseudo(el, '::after')
    // Counters created by el's children (and its pseudo-elements) go out
    // of scope with el.
    for (const stack of counters.values()) {
      while (stack.length && stack[stack.length - 1]?.scope === el) {
        stack.pop()
      }
    }
  }

  visit(document.documentElement)
  return out
}
