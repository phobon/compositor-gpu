import type { ConfigInstance, LiveConfig } from '../fx/config'
import type { InspectedElement } from '../gpu/graph'
import type { Compositor } from '../types'
import { h } from './model'
import { labelOf, selectorFor, suggestName } from './pick'

// The Edit tab (docs/EDITOR.md, E2): pick a composited element on the
// page, list the page's composited elements and config effects, and show
// what the selection is and which effects it carries. Read-only apart
// from firing triggers; editing is E3. /fx's config module is loaded on
// first show, so the devtools don't bundle the effects until then.

type ConfigModule = typeof import('../fx/config')

const MEDIA = new Set(['IMG', 'SVG', 'svg', 'CANVAS', 'VIDEO', 'PICTURE'])
/** Refresh period for the list and the selection outline, ms. */
const REFRESH_MS = 500

const fmt = (v: unknown): string => {
  if (typeof v === 'number') {
    return String(Number(v.toFixed(3)))
  }
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    return `[${Array.from(v as ArrayLike<number>, (x) => fmt(x)).join(', ')}]`
  }
  return String(v)
}

const ownText = (el: Element): boolean => {
  for (const n of el.childNodes) {
    if (n.nodeType === 3 && n.textContent?.trim()) {
      return true
    }
  }
  return false
}

export class EditView {
  readonly root = h('div', { class: 'edit' })
  private readonly bar = h('div', { class: 'bar' })
  private readonly pickBtn = h('button', {
    class: 'btn',
    type: 'button',
    text: 'Pick',
    title: 'Pick an element on the page (E)'
  })
  private readonly list = h('div', { class: 'layers' })
  private readonly inspector = h('div', { class: 'inspector' })
  private readonly overlay = h('div', { class: 'pick-overlay' })
  private readonly hoverBox = h('div', { class: 'outline pick' }, h('span'))
  private readonly selBox = h('div', { class: 'outline sel' }, h('span'))
  private cfg: ConfigModule | null = null
  private loading: Promise<void> | null = null
  private shown = false
  private picking = false
  private hovered: Element | null = null
  private point: [number, number] | null = null
  /** Ancestor steps from the candidate while picking ([ and ]). */
  private depth = 0
  private selected: Element | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private listKey = ''
  private inspectKey = ''

  constructor(
    private readonly compositor: Compositor,
    /** Where the overlays go (the devtools' shadow root container). */
    layer: HTMLElement,
    /** The devtools' host element: hits on it are the panel. */
    private readonly host: Element,
    private readonly status: (s: string) => void
  ) {
    this.overlay.hidden = true
    this.hoverBox.hidden = true
    this.selBox.hidden = true
    layer.append(this.overlay, this.hoverBox, this.selBox)
    this.pickBtn.addEventListener('click', () => this.setPicking(!this.picking))
    this.bar.append(
      this.pickBtn,
      h('span', {
        class: 'dim',
        text: 'E picks; while picking [ ] walk ancestors, Esc stops.'
      })
    )
    this.root.append(
      this.bar,
      h('div', { class: 'cols' }, this.list, this.inspector)
    )
    this.overlay.addEventListener('pointermove', (e) => {
      this.point = [e.clientX, e.clientY]
      this.depth = 0
      this.updateHover()
    })
    this.overlay.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (this.hovered) {
        this.select(this.hovered)
      }
      if (!e.shiftKey) {
        this.setPicking(false)
      }
    })
    this.overlay.addEventListener(
      'wheel',
      (e) => {
        if (e.altKey) {
          e.preventDefault()
          this.step(e.deltaY < 0 ? 1 : -1)
        }
      },
      { passive: false }
    )
  }

  show(): void {
    if (this.shown) {
      return
    }
    this.shown = true
    window.addEventListener('scroll', this.onScroll, {
      passive: true,
      capture: true
    })
    window.addEventListener('resize', this.onScroll, { passive: true })
    this.timer = setInterval(() => this.refresh(), REFRESH_MS)
    this.loading ??= import('../fx/config').then((m) => {
      this.cfg = m
    })
    void this.loading.then(() => this.refresh(true))
    this.refresh(true)
  }

  hide(): void {
    if (!this.shown) {
      return
    }
    this.shown = false
    this.setPicking(false)
    this.selBox.hidden = true
    clearInterval(this.timer)
    window.removeEventListener('scroll', this.onScroll, true)
    window.removeEventListener('resize', this.onScroll)
  }

  /** Keys while the tab shows; true when handled. */
  key(e: KeyboardEvent, inPanel: boolean): boolean {
    if (this.picking) {
      if (e.key === 'Escape') {
        this.setPicking(false)
      } else if (e.key === '[') {
        this.step(1)
      } else if (e.key === ']') {
        this.step(-1)
      } else {
        return false
      }
      return true
    }
    if (inPanel && (e.key === 'e' || e.key === 'E')) {
      this.setPicking(true)
      return true
    }
    return false
  }

  destroy(): void {
    this.hide()
    this.overlay.remove()
    this.hoverBox.remove()
    this.selBox.remove()
  }

  private readonly onScroll = (): void => {
    this.place(this.selBox, this.selected)
    if (this.picking) {
      this.updateHover()
    }
  }

  private setPicking(on: boolean): void {
    this.picking = on
    this.overlay.hidden = !on
    this.pickBtn.classList.toggle('primary', on)
    this.pickBtn.setAttribute('aria-pressed', String(on))
    if (!on) {
      this.hovered = null
      this.point = null
      this.hoverBox.hidden = true
    }
    this.status(
      on ? 'Picking: click an element. [ ] walk ancestors, Esc stops.' : ''
    )
  }

  private step(d: number): void {
    this.depth += d
    this.updateHover()
  }

  // What the page has.

  private lives(): LiveConfig[] {
    return this.cfg?.liveConfigs() ?? []
  }

  private instances(): ConfigInstance[] {
    return this.lives().flatMap((l) => l.instances())
  }

  private inspected(): InspectedElement[] {
    try {
      return this.compositor.graph?.inspect() ?? []
    } catch {
      return []
    }
  }

  private isCandidate(el: Element, known: ReadonlySet<Element>): boolean {
    return (
      el.hasAttribute('data-fx') ||
      known.has(el) ||
      MEDIA.has(el.tagName) ||
      ownText(el)
    )
  }

  private known(): Set<Element> {
    const s = new Set<Element>()
    for (const i of this.instances()) {
      if (i.el) {
        s.add(i.el)
      }
    }
    for (const i of this.inspected()) {
      s.add(i.el)
    }
    return s
  }

  // Picking.

  private hit(x: number, y: number): Element | null {
    this.overlay.style.pointerEvents = 'none'
    const els = document.elementsFromPoint(x, y)
    this.overlay.style.pointerEvents = ''
    for (const el of els) {
      if (el === this.host) {
        return null
      }
      if (el !== this.compositor.canvas) {
        return el
      }
    }
    return null
  }

  private updateHover(): void {
    const p = this.point
    const hit = p ? this.hit(p[0], p[1]) : null
    if (!hit) {
      this.hovered = null
      this.hoverBox.hidden = true
      return
    }
    const chain: Element[] = []
    for (let n: Element | null = hit; n && n !== document.documentElement; ) {
      chain.push(n)
      n = n.parentElement
    }
    const known = this.known()
    let i = chain.findIndex((el) => this.isCandidate(el, known))
    if (i < 0) {
      i = 0
    }
    this.depth = Math.max(-i, Math.min(chain.length - 1 - i, this.depth))
    const el = chain[i + this.depth] ?? hit
    this.hovered = el
    this.place(this.hoverBox, el, this.describe(el))
  }

  private describe(el: Element): string {
    const kinds = this.inspected().find((i) => i.el === el)?.kinds ?? []
    const fx = this.instances()
      .filter((i) => i.el === el)
      .map((i) => i.id)
    return [labelOf(el), ...kinds, ...fx].join(' · ')
  }

  private place(box: HTMLElement, el: Element | null, text?: string): void {
    if (!el?.isConnected) {
      box.hidden = true
      return
    }
    const r = el.getBoundingClientRect()
    Object.assign(box.style, {
      left: `${r.left - 2}px`,
      top: `${r.top - 2}px`,
      width: `${r.width + 4}px`,
      height: `${r.height + 4}px`
    })
    if (text !== undefined) {
      ;(box.firstElementChild as HTMLElement).textContent = text
    }
    box.hidden = false
  }

  // Selection.

  private select(el: Element | null): void {
    this.selected = el
    this.place(this.selBox, el, el ? labelOf(el) : '')
    this.refresh(true)
  }

  private refresh(force = false): void {
    if (!this.shown) {
      return
    }
    if (this.selected && !this.selected.isConnected) {
      this.selected = null
    }
    this.place(this.selBox, this.selected)
    this.renderList(force)
    this.renderInspector(force)
  }

  private renderList(force: boolean): void {
    const insts = this.instances()
    const page = insts.filter((i) => i.el === null)
    const rows = new Map<
      Element,
      { fx: string[]; kinds: string[]; config: boolean }
    >()
    for (const i of insts) {
      if (i.el) {
        const r = rows.get(i.el) ?? { fx: [], kinds: [], config: true }
        r.fx.push(i.id)
        rows.set(i.el, r)
      }
    }
    for (const i of this.inspected()) {
      const r = rows.get(i.el) ?? { fx: [], kinds: [], config: false }
      r.kinds.push(...i.kinds)
      rows.set(i.el, r)
    }
    const els = [...rows.keys()]
    const key = JSON.stringify([
      page.map((i) => [i.id, i.handle.enabled]),
      els.map((el) => [labelOf(el), rows.get(el)]),
      this.selected ? els.indexOf(this.selected) : -2,
      this.cfg !== null
    ])
    if (!force && key === this.listKey) {
      return
    }
    this.listKey = key
    const row = (
      label: string,
      chips: string[],
      opts: { dim?: boolean; on?: boolean; el?: Element }
    ): HTMLElement => {
      const b = h(
        'button',
        {
          class: `row${opts.dim ? ' dimrow' : ''}${opts.on ? ' on' : ''}`,
          type: 'button'
        },
        h('span', { class: 'rl', text: label }),
        ...chips.map((c) => h('span', { class: 'kind', text: c }))
      )
      const el = opts.el
      if (el) {
        b.addEventListener('click', () => {
          this.select(el)
          const r = el.getBoundingClientRect()
          if (r.bottom < 0 || r.top > window.innerHeight) {
            el.scrollIntoView({ block: 'center' })
          }
        })
        b.addEventListener('mouseenter', () =>
          this.place(this.hoverBox, el, labelOf(el))
        )
        b.addEventListener('mouseleave', () => {
          if (!this.picking) {
            this.hoverBox.hidden = true
          }
        })
      }
      return b
    }
    const kids: HTMLElement[] = []
    if (page.length) {
      kids.push(h('h3', { text: 'Page effects' }))
      for (const i of page) {
        kids.push(
          row(i.id, [i.effect, i.handle.enabled ? 'on' : 'off'], {
            dim: !i.handle.enabled
          })
        )
      }
    }
    kids.push(h('h3', { text: 'Elements' }))
    if (els.length === 0) {
      kids.push(
        h('p', {
          class: 'empty',
          text: 'Nothing composited as a group, region, transform or material, and no config effects.'
        })
      )
    }
    for (const el of els) {
      const r = rows.get(el)
      if (r) {
        kids.push(
          row(labelOf(el), [...r.fx, ...r.kinds], {
            dim: !r.config,
            on: el === this.selected,
            el
          })
        )
      }
    }
    this.list.replaceChildren(...kids)
  }

  private renderInspector(force: boolean): void {
    const el = this.selected
    const insts = el ? this.instances().filter((i) => i.el === el) : []
    const info = el ? this.inspected().find((i) => i.el === el) : undefined
    const key = JSON.stringify([
      el ? labelOf(el) : null,
      info?.kinds,
      info?.materials,
      insts.map((i) => [
        i.cfg,
        i.handle.enabled,
        Object.values(i.handle.params).map(fmt)
      ]),
      this.lives().length
    ])
    if (!force && key === this.inspectKey) {
      return
    }
    this.inspectKey = key
    if (!el) {
      this.inspector.replaceChildren(
        h('p', {
          class: 'empty',
          text: 'Pick an element (E) or choose one from the list.'
        })
      )
      return
    }
    const kv = (k: string, ...v: (Node | string)[]): HTMLElement =>
      h(
        'div',
        { class: 'kv' },
        h('span', { class: 'k', text: k }),
        h('span', {}, ...v)
      )
    const fx = el.getAttribute('data-fx')
    const match = fx
      ? h('code', { text: `[data-fx="${fx}"]` })
      : h(
          'span',
          {},
          h('code', {
            text: selectorFor(el, (s) => {
              try {
                return document.querySelectorAll(s).length
              } catch {
                return 0
              }
            })
          }),
          ' ',
          h('span', {
            class: 'kind warn',
            text: 'fragile',
            title: 'A generated selector: breaks when the markup changes'
          }),
          ' ',
          this.copyButton(`data-fx="${suggestName(el)}"`)
        )
    const r = el.getBoundingClientRect()
    const parts: HTMLElement[] = [
      h('h3', { text: labelOf(el, 80) }),
      kv('match', match),
      kv('size', `${Math.round(r.width)} × ${Math.round(r.height)} CSS px`),
      kv(
        'composited',
        info?.kinds.length
          ? info.kinds
              .map((k) =>
                k === 'opacity' && info.alpha !== undefined
                  ? `opacity ${fmt(info.alpha)}`
                  : k
              )
              .join(', ')
          : 'records in its parent’s target'
      )
    ]
    if (info?.materials.length) {
      parts.push(kv('materials', info.materials.join(', ')))
    }
    parts.push(h('h3', { text: 'Config effects' }))
    if (this.lives().length === 0) {
      parts.push(
        h('p', {
          class: 'dim',
          text: this.cfg
            ? 'No applyConfig on this page.'
            : 'Loading the config module…'
        })
      )
    } else if (insts.length === 0) {
      parts.push(h('p', { class: 'dim', text: 'None on this element.' }))
    }
    for (const i of insts) {
      parts.push(this.effectCard(i))
    }
    this.inspector.replaceChildren(...parts)
  }

  private effectCard(i: ConfigInstance): HTMLElement {
    const live = this.lives().find((l) =>
      l.instances().some((x) => x.handle === i.handle)
    )
    const params = h(
      'table',
      {},
      h(
        'tbody',
        {},
        ...Object.entries(i.handle.params).map(([k, v]) =>
          h(
            'tr',
            {},
            h('td', { class: 'dim', text: k }),
            h('td', {
              text: fmt(v),
              class: i.cfg.params && k in i.cfg.params ? 'set' : ''
            })
          )
        )
      )
    )
    const triggers = (i.cfg.triggers ?? []).map((t, n) => {
      const what = [
        t.to === 'rest' ? 'to rest' : t.to ? `to ${JSON.stringify(t.to)}` : '',
        t.play ? `play ${t.play}` : '',
        t.enabled === undefined ? '' : t.enabled ? 'enable' : 'disable'
      ]
        .filter(Boolean)
        .join(', ')
      const fire = h('button', {
        class: 'btn',
        type: 'button',
        text: 'Fire',
        title: 'Run this trigger from the rest values'
      })
      fire.addEventListener('click', () =>
        live?.fire(i.id, n, { fromRest: true })
      )
      return h(
        'div',
        { class: 'event' },
        h('span', { class: 'kind', text: t.on }),
        h('span', { class: 'ek', text: what || '—' }),
        fire
      )
    })
    return h(
      'div',
      { class: 'factor' },
      h(
        'div',
        { class: 'fhead' },
        h('strong', { text: i.id }),
        h('span', { class: 'kind', text: i.effect }),
        h('span', {
          class: 'dim',
          text: i.handle.enabled ? 'enabled' : 'disabled'
        })
      ),
      params,
      triggers.length
        ? h('div', { class: 'events' }, ...triggers)
        : h('p', { class: 'dim', text: 'No triggers.' })
    )
  }

  private copyButton(text: string): HTMLElement {
    const b = h('button', {
      class: 'btn',
      type: 'button',
      text: 'Copy data-fx',
      title: `Copy ${text} to paste into the markup`
    })
    b.addEventListener('click', () => {
      void navigator.clipboard?.writeText(text).then(
        () => this.status(`Copied ${text}`),
        () => this.status(text)
      )
    })
    return b
  }
}
