// Edit tab helpers (src/devtools/pick.ts): selectors that match one
// element, data-fx name suggestions, labels.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  labelOf,
  type PickNode,
  selectorFor,
  suggestName
} from '../../src/devtools/pick'

class N implements PickNode {
  parentElement: N | null = null
  readonly children: N[] = []
  constructor(
    readonly tagName: string,
    readonly id = '',
    readonly classList: string[] = [],
    readonly attrs: Record<string, string> = {}
  ) {}
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null
  }
  add(...kids: N[]): this {
    for (const k of kids) {
      k.parentElement = this
      this.children.push(k)
    }
    return this
  }
}

/** Every node under `root`, for a selector counter that understands the
 * selectors selectorFor writes (only by structure: each segment is
 * matched against the node at that depth from the end). */
function counter(root: N): (sel: string) => number {
  const all: N[] = []
  const walk = (n: N): void => {
    all.push(n)
    n.children.forEach(walk)
  }
  walk(root)
  const matches = (n: N, seg: string): boolean => {
    if (seg.startsWith('#')) {
      return n.id === seg.slice(1)
    }
    const fx = /^\[data-fx="(.*)"\]$/.exec(seg)?.[1]
    if (fx !== undefined) {
      return n.attrs['data-fx'] === fx
    }
    const m = /^([a-z0-9]+)((?:\.[\w-]+)*)(?::nth-of-type\((\d+)\))?$/.exec(seg)
    if (!m) {
      return false
    }
    const [, tag, cls, nth] = m
    if (n.tagName.toLowerCase() !== tag) {
      return false
    }
    for (const c of (cls ?? '').split('.').filter(Boolean)) {
      if (!n.classList.includes(c)) {
        return false
      }
    }
    if (nth) {
      const same = (n.parentElement?.children ?? []).filter(
        (c) => c.tagName === n.tagName
      )
      return same.indexOf(n) + 1 === Number(nth)
    }
    return true
  }
  return (sel) => {
    const segs = sel.split(' > ')
    return all.filter((n) => {
      let cur: N | null = n
      for (let i = segs.length - 1; i >= 0; i--) {
        if (!cur || !matches(cur, segs[i] as string)) {
          return false
        }
        cur = cur.parentElement
      }
      return true
    }).length
  }
}

test('an id or data-fx ancestor anchors the selector', () => {
  const img = new N('IMG')
  const card = new N('DIV', '', ['card']).add(img)
  const root = new N('BODY').add(
    new N('MAIN', 'main').add(
      card,
      new N('DIV', '', ['card']).add(new N('IMG'))
    )
  )
  const sel = selectorFor(img, counter(root))
  assert.equal(sel, 'div.card:nth-of-type(1) > img')
  assert.equal(counter(root)(sel), 1)

  const a = new N('A')
  const r1 = new N('BODY').add(new N('NAV', 'nav').add(a), new N('A'))
  assert.equal(selectorFor(a, counter(r1)), '#nav > a')

  const named = new N('SECTION', '', [], { 'data-fx': 'hero' }).add(new N('H2'))
  const r2 = new N('BODY').add(named, new N('SECTION').add(new N('H2')))
  assert.equal(
    selectorFor(named.children[0] as N, counter(r2)),
    '[data-fx="hero"] > h2'
  )
})

test('stops as soon as the selector is unique', () => {
  const p = new N('P', '', ['lede'])
  const root = new N('BODY').add(new N('ARTICLE').add(p))
  assert.equal(selectorFor(p, counter(root)), 'p.lede')
})

test('generated classes are left out', () => {
  const b = new N('BUTTON', '', ['css-1x2y3z', 'Button_root__a8f3k', 'cta'])
  const root = new N('BODY').add(b)
  assert.equal(selectorFor(b, counter(root)), 'button.cta')
})

test('suggested names and labels', () => {
  assert.equal(suggestName(new N('DIV', 'heroCard')), 'hero-card')
  assert.equal(suggestName(new N('DIV', '', ['feature_tile'])), 'feature-tile')
  assert.equal(suggestName(new N('IMG')), 'img')
  assert.equal(
    suggestName(new N('IMG', '', [], { 'data-fx': 'photo' })),
    'photo'
  )
  assert.equal(labelOf(new N('DIV', 'a', ['b', 'c', 'd'])), 'div#a.b.c')
  assert.equal(
    labelOf(new N('IMG', '', [], { 'data-fx': 'photo' })),
    'img[data-fx=photo]'
  )
  assert.ok(labelOf(new N('DIV', 'x'.repeat(80)), 20).length <= 20)
})
