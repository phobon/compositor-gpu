// Config runtime (src/fx/config.ts) against a registered probe effect
// and fake elements: matching, rest values, triggers, update() diffing.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyConfig,
  type ConfigClock,
  type FxConfig
} from '../../src/fx/config'
import type { Effects } from '../../src/fx/effects'
import { type EffectHandle, registerEffect } from '../../src/fx/registry'

class FakeTarget {
  readonly listeners = new Map<string, Set<(e: Event) => void>>()
  addEventListener(type: string, h: (e: Event) => void): void {
    let s = this.listeners.get(type)
    if (!s) {
      s = new Set()
      this.listeners.set(type, s)
    }
    s.add(h)
  }
  removeEventListener(type: string, h: (e: Event) => void): void {
    this.listeners.get(type)?.delete(h)
  }
  dispatch(type: string, extra: object = {}): void {
    for (const h of [...(this.listeners.get(type) ?? [])]) {
      h({ type, currentTarget: this, ...extra } as unknown as Event)
    }
  }
  count(): number {
    let n = 0
    for (const s of this.listeners.values()) {
      n += s.size
    }
    return n
  }
}

class FakeEl extends FakeTarget {
  constructor(
    readonly fx: string | null,
    readonly cls: string | null = null
  ) {
    super()
  }
}

interface Page {
  els: FakeEl[]
  doc: FakeTarget
  root: ParentNode
}

function page(...els: FakeEl[]): Page {
  const doc = new FakeTarget()
  const p: Page = { els, doc, root: null as unknown as ParentNode }
  p.root = {
    ownerDocument: doc,
    querySelectorAll(sel: string) {
      const fx = /^\[data-fx="(.*)"\]$/.exec(sel)?.[1]
      if (fx !== undefined) {
        return p.els.filter((e) => e.fx === fx)
      }
      if (sel.startsWith('.')) {
        return p.els.filter((e) => e.cls === sel.slice(1))
      }
      throw new Error('bad selector')
    }
  } as unknown as ParentNode
  return p
}

function clock() {
  let now = 0
  let cbs: ((t: number) => void)[] = []
  const c: ConfigClock = {
    now: () => now,
    request(cb) {
      cbs.push(cb)
      return cbs.length
    },
    cancel() {
      cbs = []
    }
  }
  return {
    c,
    /** Run frames up to `to` ms, every 16 ms. */
    run(to: number) {
      while (now < to && cbs.length) {
        now = Math.min(to, now + 16)
        const run = cbs
        cbs = []
        for (const cb of run) {
          cb(now)
        }
      }
      now = to
    }
  }
}

interface Probe extends EffectHandle {
  readonly params: Record<string, unknown>
  el: Element | null
  destroyed: boolean
  played: unknown[]
}

const probes: Probe[] = []
registerEffect({
  id: 'probe',
  label: 'Probe',
  scopes: ['page', 'element'],
  schema: {
    a: { type: 'f32', default: 1 },
    tint: { type: 'color', default: '#000000' },
    progress: { type: 'f32', default: 0 }
  },
  create(_fx, el) {
    const p: Probe = {
      params: { a: 1, tint: [0, 0, 0, 1], progress: 0 },
      enabled: true,
      el,
      destroyed: false,
      played: [],
      destroy() {
        p.destroyed = true
      }
    }
    probes.push(p)
    return p
  }
})
registerEffect({
  id: 'kick',
  label: 'Kick',
  scopes: ['page'],
  schema: { a: { type: 'f32', default: 0 } },
  impulse: true,
  create() {
    const p: Probe = {
      params: { a: 0 },
      enabled: true,
      el: null,
      destroyed: false,
      played: [],
      play(at) {
        p.played.push(at)
      },
      destroy() {
        p.destroyed = true
      }
    }
    probes.push(p)
    return p
  }
})

const fx = (reduced = false): Effects =>
  ({ active: true, reducedMotion: reduced }) as unknown as Effects

const LINEAR: [number, number, number, number] = [0, 0, 1, 1]

const hover = (): FxConfig => ({
  version: 1,
  elements: [
    {
      match: { selector: '.card' },
      effects: [
        {
          id: 'light',
          effect: 'probe',
          params: { a: 2, tint: '#ff0000' },
          triggers: [
            { on: 'pointerenter', to: { a: 4 }, duration: 1, ease: LINEAR },
            { on: 'pointerleave', to: 'rest', duration: 1, ease: LINEAR }
          ]
        }
      ]
    }
  ]
})

const fresh = () => {
  probes.length = 0
}

test('one instance per matched element, at its rest params', () => {
  fresh()
  const p = page(new FakeEl(null, 'card'), new FakeEl(null, 'card'))
  const live = applyConfig(fx(), hover(), { root: p.root, clock: clock().c })
  assert.equal(probes.length, 2)
  assert.equal(live.get('light').length, 2)
  for (const pr of probes) {
    assert.equal(pr.params.a, 2)
    assert.deepEqual(pr.params.tint, [1, 0, 0, 1])
    assert.equal(pr.params.progress, 0)
  }
  live.destroy()
  assert.ok(probes.every((pr) => pr.destroyed))
  assert.ok(p.els.every((e) => e.count() === 0))
})

test('pointerenter tweens to `to`, pointerleave back to rest', () => {
  fresh()
  const p = page(new FakeEl(null, 'card'))
  const k = clock()
  applyConfig(fx(), hover(), { root: p.root, clock: k.c })
  const el = p.els[0] as FakeEl
  const pr = probes[0] as Probe
  el.dispatch('pointerenter')
  k.run(500)
  assert.ok(Math.abs((pr.params.a as number) - 3) < 0.05)
  el.dispatch('pointerleave')
  k.run(2000)
  assert.equal(pr.params.a, 2)
})

test('an equal config changes nothing; an edit resets only its effect', () => {
  fresh()
  const p = page(new FakeEl('hero'), new FakeEl(null, 'card'))
  const k = clock()
  const cfg = hover()
  const withHero: FxConfig = {
    ...cfg,
    elements: [
      ...(cfg.elements ?? []),
      { match: { fx: 'hero' }, effects: [{ id: 'h', effect: 'probe' }] }
    ]
  }
  const live = applyConfig(fx(), withHero, { root: p.root, clock: k.c })
  const [hero, card] = [probes[1] as Probe, probes[0] as Probe]
  assert.equal(hero.el, p.els[0])
  hero.params.a = 9
  live.update(JSON.parse(JSON.stringify(withHero)))
  assert.equal(probes.length, 2)
  assert.equal(hero.params.a, 9)

  const edited = JSON.parse(JSON.stringify(withHero)) as FxConfig
  const light = edited.elements?.[0]?.effects[0]
  assert.ok(light)
  ;(light as { params: object }).params = { a: 5 }
  live.update(edited)
  assert.equal(probes.length, 2, 'same effect: no rebuild')
  assert.equal(card.params.a, 5)
  assert.deepEqual(card.params.tint, [0, 0, 0, 1], 'unset param back to base')
  assert.equal(hero.params.a, 9, 'other effects untouched')

  const swapped = JSON.parse(JSON.stringify(edited)) as FxConfig
  const h = swapped.elements?.[1]?.effects[0]
  assert.ok(h)
  ;(h as { effect: string }).effect = 'missing'
  live.update(swapped)
  assert.ok(hero.destroyed, 'effect type changed: old one destroyed')
  live.destroy()
})

test('a params-only edit retunes without running load again', () => {
  fresh()
  const p = page()
  const k = clock()
  const cfg = (a: number): FxConfig => ({
    version: 1,
    page: [
      {
        id: 'p',
        effect: 'probe',
        params: { a },
        triggers: [{ on: 'load', play: 'forward', duration: 0 }]
      }
    ]
  })
  const live = applyConfig(fx(), cfg(1), { root: p.root, clock: k.c })
  const pr = probes[0] as Probe
  assert.equal(pr.params.progress, 1, 'load ran')
  pr.params.progress = 0.5
  live.update(cfg(3))
  assert.equal(pr.params.a, 3)
  assert.equal(pr.params.progress, 0.5, 'untouched; load not run again')
  assert.equal(probes.length, 1)
})

test('listeners are rebound, not stacked, across edits', () => {
  fresh()
  const p = page(new FakeEl(null, 'card'))
  const live = applyConfig(fx(), hover(), { root: p.root, clock: clock().c })
  const el = p.els[0] as FakeEl
  assert.equal(el.count(), 2)
  for (const a of [3, 4, 5]) {
    const c = hover()
    ;(c.elements?.[0]?.effects[0] as { params: object }).params = { a }
    live.update(c)
  }
  assert.equal(el.count(), 2)
  live.update({ version: 1 })
  assert.equal(el.count(), 0)
  assert.ok(probes[0]?.destroyed)
})

test('resolve() adds newly matched elements and keeps the others running', () => {
  fresh()
  const p = page(new FakeEl(null, 'card'))
  const k = clock()
  const live = applyConfig(fx(), hover(), { root: p.root, clock: k.c })
  const first = probes[0] as Probe
  ;(p.els[0] as FakeEl).dispatch('pointerenter')
  k.run(1000)
  p.els.push(new FakeEl(null, 'card'))
  live.resolve()
  assert.equal(probes.length, 2)
  assert.equal(first.params.a, 4, 'not reset')
  p.els.shift()
  live.resolve()
  assert.ok(first.destroyed)
})

test('play toggles progress; a one-shot plays at the click point', () => {
  fresh()
  const p = page(new FakeEl('btn'))
  const k = clock()
  const live = applyConfig(
    fx(),
    {
      version: 1,
      page: [
        {
          id: 'kick',
          effect: 'kick',
          triggers: [{ on: 'click', play: 'forward' }]
        }
      ],
      elements: [
        {
          match: { fx: 'btn' },
          effects: [
            {
              id: 'p',
              effect: 'probe',
              triggers: [{ on: 'click', play: 'toggle', duration: 0.5 }]
            }
          ]
        }
      ]
    },
    { root: p.root, clock: k.c }
  )
  const [kick, pr] = [probes[0] as Probe, probes[1] as Probe]
  const btn = p.els[0] as FakeEl
  btn.dispatch('click')
  k.run(1000)
  assert.equal(pr.params.progress, 1)
  btn.dispatch('click')
  k.run(2000)
  assert.equal(pr.params.progress, 0)
  p.doc.dispatch('click', { pageX: 10, pageY: 20 })
  assert.deepEqual(kick.played, [[10, 20]])
  live.fire('kick', 'click')
  assert.equal(kick.played.length, 2)
  // fromRest: a forward play that already ran plays again.
  live.update({
    version: 1,
    page: [
      {
        id: 'fwd',
        effect: 'probe',
        triggers: [{ on: 'load', play: 'forward', duration: 1 }]
      }
    ]
  })
  const fwd = probes[probes.length - 1] as Probe
  k.run(5000)
  assert.equal(fwd.params.progress, 1)
  live.fire('fwd', 0, { fromRest: true })
  assert.equal(fwd.params.progress, 0)
  k.run(5500)
  assert.ok((fwd.params.progress as number) > 0.2)
  live.destroy()
})

test('enabled: false lands the tween first; once fires once', async () => {
  fresh()
  const p = page(new FakeEl('a'))
  const k = clock()
  applyConfig(
    fx(),
    {
      version: 1,
      elements: [
        {
          match: { fx: 'a' },
          effects: [
            {
              id: 'p',
              effect: 'probe',
              enabled: false,
              triggers: [
                { on: 'pointerenter', enabled: true, to: { a: 3 }, once: true },
                {
                  on: 'pointerleave',
                  to: { a: 0 },
                  enabled: false,
                  duration: 0.2
                }
              ]
            }
          ]
        }
      ]
    },
    { root: p.root, clock: k.c }
  )
  const pr = probes[0] as Probe
  const el = p.els[0] as FakeEl
  assert.equal(pr.enabled, false)
  el.dispatch('pointerenter')
  assert.equal(pr.enabled, true)
  k.run(1000)
  el.dispatch('pointerleave')
  k.run(1100)
  assert.equal(pr.enabled, true, 'still tweening')
  k.run(2000)
  assert.equal(pr.enabled, false)
  assert.equal(pr.params.a, 0)
  await Promise.resolve()
  el.dispatch('pointerenter')
  assert.equal(pr.enabled, false, 'once: not again')
})

test('reduced motion lands at once; load fires on apply', () => {
  fresh()
  const p = page()
  applyConfig(
    fx(true),
    {
      version: 1,
      page: [
        {
          id: 'p',
          effect: 'probe',
          triggers: [{ on: 'load', to: { a: 7 }, duration: 2 }]
        }
      ]
    },
    { root: p.root, clock: clock().c }
  )
  assert.equal(probes[0]?.params.a, 7)
})

test('an element-only effect on the page and unknown params are skipped', () => {
  fresh()
  const p = page()
  const warn = console.warn
  const warnings: string[] = []
  console.warn = (m: string) => warnings.push(m)
  try {
    const live = applyConfig(
      fx(),
      {
        version: 1,
        page: [
          { id: 's', effect: 'spotlight' },
          { id: 'p', effect: 'probe', params: { nope: 1 } }
        ]
      },
      { root: p.root, clock: clock().c }
    )
    assert.equal(live.get('s').length, 0)
    assert.equal(live.get('p').length, 1)
  } finally {
    console.warn = warn
  }
  assert.equal(warnings.length, 2)
})

test('the presets are registered with their schemas', async () => {
  const { listEffects } = await import('../../src/fx/registry')
  const ids = listEffects().map((d) => d.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ['blur', 'spotlight', 'reveal', 'shockwave', 'motion']) {
    assert.ok(ids.includes(id), id)
  }
  for (const d of listEffects()) {
    assert.ok(Object.keys(d.schema).length > 0, d.id)
  }
  const progress = listEffects()
    .filter((d) => d.schema.progress)
    .map((d) => d.id)
  assert.deepEqual(progress.filter((id) => id !== 'probe').sort(), [
    'develop',
    'dissolve',
    'motion',
    'reveal',
    'textStagger'
  ])
})

test('enter: past the line at load lands, below it plays on entry', () => {
  fresh()
  type Cb = (r: Partial<IntersectionObserverEntry>[]) => void
  const ios: { cb: Cb; opts: IntersectionObserverInit; els: Element[] }[] = []
  const g = globalThis as { IntersectionObserver?: unknown }
  const prev = g.IntersectionObserver
  g.IntersectionObserver = class {
    readonly rec: { cb: Cb; opts: IntersectionObserverInit; els: Element[] }
    constructor(cb: Cb, opts: IntersectionObserverInit) {
      this.rec = { cb, opts, els: [] }
      ios.push(this.rec)
    }
    observe(el: Element) {
      this.rec.els.push(el)
    }
    disconnect() {}
  }
  try {
    const p = page(new FakeEl(null, 'card'), new FakeEl(null, 'card'))
    const k = clock()
    applyConfig(
      fx(),
      {
        version: 1,
        elements: [
          {
            match: { selector: '.card' },
            effects: [
              {
                id: 'r',
                effect: 'probe',
                triggers: [
                  {
                    on: 'enter',
                    play: 'forward',
                    duration: 1,
                    once: true,
                    rootMargin: '0px 0px -20% 0px'
                  }
                ]
              }
            ]
          }
        ]
      },
      { root: p.root, clock: k.c }
    )
    assert.equal(ios.length, 2)
    assert.equal(ios[0]?.opts.rootMargin, '0px 0px -20% 0px')
    const [past, below] = [probes[0] as Probe, probes[1] as Probe]
    const rootBounds = { bottom: 800 } as DOMRectReadOnly
    const at = (el: Element, top: number, hit: boolean) => ({
      target: el,
      isIntersecting: hit,
      rootBounds,
      boundingClientRect: { top } as DOMRectReadOnly
    })
    ios[0]?.cb([at(p.els[0] as unknown as Element, -300, false)])
    ios[1]?.cb([at(p.els[1] as unknown as Element, 1200, false)])
    assert.equal(past.params.progress, 1, 'landed without a tween')
    assert.equal(below.params.progress, 0)
    ios[1]?.cb([at(p.els[1] as unknown as Element, 700, true)])
    k.run(500)
    const mid = below.params.progress as number
    assert.ok(mid > 0 && mid < 1, `playing: ${mid}`)
    k.run(2000)
    assert.equal(below.params.progress, 1)
  } finally {
    g.IntersectionObserver = prev
  }
})
