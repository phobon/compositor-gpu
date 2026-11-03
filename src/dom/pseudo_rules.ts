import { splitTopLevel } from '../util/css'

// Which elements can have a `::before` / `::after` (or a `::marker` with
// list-style none), and which subtrees can hold a `position: fixed`
// element, from the document's style rules. A pseudo-element
// box only exists when a rule gives it `content`, so reading every
// element's two pseudo styles (most of them `content: none`) can be
// skipped for elements no such rule's selector matches. When a sheet
// can't be read (cross-origin) or a rule is beyond this scan (a nested
// rule under a pseudo-element), every element is read as before.

export type PseudoName = '::before' | '::after' | '::marker'

const PSEUDO = /::?(before|after|marker)\b/i

/** The selector a pseudo-element selector applies to: `.a:hover::before`
 * -> `.a:hover`, `ul > ::marker` -> `ul > *`. Null when the pseudo isn't
 * the last thing in it (something this scan doesn't model). */
export function hostSelector(
  sel: string
): { name: PseudoName; host: string } | null {
  const m = PSEUDO.exec(sel)
  if (!m) {
    return null
  }
  const rest = sel.slice(m.index + m[0].length).trim()
  if (rest && !/^(:[\w-]+(\([^)]*\))?)+$/.test(rest)) {
    return null
  }
  const name = `::${(m[1] ?? '').toLowerCase()}` as PseudoName
  let host = sel.slice(0, m.index).trim()
  if (!host || /[\s>+~]$/.test(sel.slice(0, m.index))) {
    host = `${host} *`.trim()
  }
  return { name, host }
}

type Hosts = Record<PseudoName, string[]> & {
  /** Selectors of rules setting `position: fixed`. */
  fixed: string[]
  /** Selectors of the rules using each custom property (`var(--x)`) in a
   * property's value. */
  vars: Record<string, string[]>
  /** The custom properties whose own value uses each one (`--a:
   * var(--x)` makes --a depend on --x). */
  chains: Record<string, string[]>
}

const VAR_USE = /var\(\s*(--[\w-]+)/g
const DECL = /(?:^|;)\s*([-\w]+)\s*:\s*([^;]*)/g

/** Pseudo-elements the browser's own stylesheet gives content, which
 * isn't in document.styleSheets (Chrome's: `q::before { content:
 * open-quote }` and its close-quote `::after`). */
const UA_HOSTS: Record<PseudoName, string[]> = {
  '::before': ['q'],
  '::after': ['q'],
  '::marker': []
}

/** A nested rule's selector against its parent's: `&` stands for the
 * parent, and a part without one is a descendant of it. */
export function nestSelector(sel: string, parent: string): string {
  const of = `:is(${parent})`
  return splitTopLevel(sel, ',')
    .map((part) => {
      const p = part.trim()
      return p.includes('&') ? p.replaceAll('&', of) : `${of} ${p}`
    })
    .join(', ')
}

/** Host selectors of every rule that gives a pseudo-element `content`,
 * or null when some rule or sheet can't be modelled. */
export function scanRules(rules: Iterable<CSSRule>): Hosts | null {
  const out: Hosts = {
    '::before': [...UA_HOSTS['::before']],
    '::after': [...UA_HOSTS['::after']],
    '::marker': [...UA_HOSTS['::marker']],
    fixed: [],
    vars: {},
    chains: {}
  }
  const declare = (selector: string, style: CSSStyleDeclaration): boolean => {
    // The declarations' text, shorthands included (a longhand set from a
    // shorthand with var() reads empty).
    const text = style.cssText
    if (text.includes('var(')) {
      const hosts = splitTopLevel(selector, ',').map((part) => {
        const h = hostSelector(part.trim())
        return h ? h.host : part.trim()
      })
      for (const d of text.matchAll(DECL)) {
        const prop = d[1] as string
        for (const m of (d[2] as string).matchAll(VAR_USE)) {
          const name = m[1] as string
          const into = prop.startsWith('--') ? out.chains : out.vars
          const list = into[name] ?? []
          into[name] = list
          list.push(...(prop.startsWith('--') ? [prop] : hosts))
        }
      }
    }
    if (style.getPropertyValue('position') === 'fixed') {
      for (const part of splitTopLevel(selector, ',')) {
        const h = hostSelector(part.trim())
        out.fixed.push(h ? h.host : part.trim())
      }
    }
    if (!PSEUDO.test(selector) || !style.getPropertyValue('content')) {
      return true
    }
    for (const part of splitTopLevel(selector, ',')) {
      const h = hostSelector(part.trim())
      if (h) {
        out[h.name].push(h.host)
      } else if (PSEUDO.test(part)) {
        return false
      }
    }
    return true
  }
  const visit = (list: Iterable<CSSRule>, parent: string | null): boolean => {
    for (const r of list) {
      const style = (r as CSSStyleRule).style
      const own = (r as CSSStyleRule).selectorText
      const kids = (r as CSSGroupingRule).cssRules
      if (typeof own === 'string' && style) {
        const selector = parent === null ? own : nestSelector(own, parent)
        if (!declare(selector, style)) {
          return false
        }
        if (kids && kids.length > 0) {
          if (PSEUDO.test(selector) || !visit(Array.from(kids), selector)) {
            return false
          }
        }
      } else if (style && parent !== null) {
        if (!declare(parent, style)) {
          return false
        }
      } else if (kids) {
        if (!visit(Array.from(kids), parent)) {
          return false
        }
      } else {
        const sheet = (r as CSSImportRule).styleSheet
        const sub = sheet ? rulesOf(sheet) : []
        if (!sub || !visit(sub, null)) {
          return false
        }
      }
    }
    return true
  }
  return visit(rules, null) ? out : null
}

function rulesOf(sheet: CSSStyleSheet): CSSRule[] | null {
  try {
    return Array.from(sheet.cssRules)
  } catch {
    return null
  }
}

/** The document's pseudo-element rules, rescanned when its sheets change
 * (their count or their rule counts). */
export class PseudoRules {
  private signature = ''
  private hosts: Record<PseudoName, string | null> | null = null
  /** Selector list matching an element that can be `position: fixed`
   * (rules, and inline styles naming it), or null when unknown. */
  private fixed: string | null = null
  private vars: {
    uses: Record<string, string[]>
    chains: Record<string, string[]>
  } | null = null

  /** Rescan if the document's sheets changed since the last call. */
  refresh(): void {
    const sheets = [
      ...Array.from(document.styleSheets),
      ...(document.adoptedStyleSheets ?? [])
    ]
    const lists = sheets.map(rulesOf)
    const sig = lists.map((l) => (l ? l.length : -1)).join(',')
    if (sig === this.signature) {
      return
    }
    this.signature = sig
    if (lists.some((l) => l === null)) {
      this.hosts = null
      this.fixed = null
      this.vars = null
      return
    }
    const found = scanRules(lists.flatMap((l) => l ?? []))
    this.vars = found ? { uses: found.vars, chains: found.chains } : null
    this.fixed = found ? [...found.fixed, '[style*="fixed" i]'].join(',') : null
    this.hosts = found
      ? {
          '::before': found['::before'].join(',') || null,
          '::after': found['::after'].join(',') || null,
          '::marker': found['::marker'].join(',') || null
        }
      : null
  }

  /** Elements under `root` whose style can use one of `names` (custom
   * properties): matched by a rule using it, or naming it in an inline
   * style, or using a custom property defined from one; null when
   * unknown (an unreadable sheet). */
  varUsers(names: readonly string[], root: Element): Element[] | null {
    this.refresh()
    const vars = this.vars
    if (!vars) {
      return null
    }
    // The named properties and every custom property defined from them.
    const all = new Set(names)
    for (const n of all) {
      for (const d of vars.chains[n] ?? []) {
        all.add(d)
      }
    }
    const sel: string[] = []
    for (const n of all) {
      sel.push(...(vars.uses[n] ?? []), `[style*="${CSS.escape(n)}"]`)
    }
    try {
      return Array.from(root.querySelectorAll(sel.join(',')))
    } catch {
      return null
    }
  }

  /** Whether the scan could model every rule's `position: fixed`. */
  get knowsFixed(): boolean {
    return this.fixed !== null
  }

  /** Whether something in `el`'s subtree can be `position: fixed`
   * (true when unsure). */
  mayHoldFixed(el: Element): boolean {
    if (this.fixed === null) {
      return true
    }
    try {
      // `el` itself for a fixed pseudo-element of it.
      return el.matches(this.fixed) || el.querySelector(this.fixed) !== null
    } catch {
      return true
    }
  }

  /** Whether a rule can give `el` this pseudo-element (true when unsure). */
  may(el: Element, name: PseudoName): boolean {
    if (!this.hosts || el.getRootNode() !== document) {
      return true
    }
    const list = this.hosts[name]
    if (list === null) {
      return false
    }
    try {
      return el.matches(list)
    } catch {
      return true
    }
  }
}
