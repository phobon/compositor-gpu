import type {
  ConfigInstance,
  FxConfig,
  LiveConfig,
  Match,
  ParamInput
} from '../fx/config'
import type { EffectDef } from '../fx/registry'
import type { InspectedElement } from '../gpu/graph'
import type { Compositor } from '../types'
import { describeDiff, diffConfigs } from './edit_file'
import { paramRow, triggerRow } from './edit_form'
import {
  addEffect,
  findEffect,
  History,
  removeEffect,
  setEnabled,
  setMedia,
  setParam,
  setTrigger,
  uniqueId
} from './edit_model'
import { download, FileStore, upload } from './edit_store'
import { h } from './model'
import { labelOf, selectorFor, suggestName } from './pick'

// The Edit tab (docs/EDITOR.md, E2, E3): pick a composited element on
// the page, list the page's composited elements and config effects, and
// edit the selection's effects: add and remove them, their rest params,
// enabled and triggers, through LiveConfig.update(), with undo; save the
// config to a file (edit_store.ts: autosave, a draft until written). /fx's
// config, registry and runtime are loaded on first show, so the devtools
// don't bundle the effects until then.

interface Mods {
  config: typeof import('../fx/config')
  registry: typeof import('../fx/registry')
  effects: typeof import('../fx/effects')
}

/** The element picked, or a page effect chosen in the list. */
type Selection = { el: Element } | { page: string }

const MEDIA = new Set(['IMG', 'SVG', 'svg', 'CANVAS', 'VIDEO', 'PICTURE'])
/** Refresh period for the list, the inspector and the outlines, ms. */
const REFRESH_MS = 500
/** Autosave after the last change, ms. */
const AUTOSAVE_MS = 300
const AUTOSAVE_KEY = 'compositor-gpu:edit-autosave'

const fmt = (v: unknown): string => {
  if (typeof v === 'number') {
    return String(Number(v.toFixed(3)))
  }
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    return `[${Array.from(v as ArrayLike<number>, (x) => fmt(x)).join(', ')}]`
  }
  return String(v)
}

const toVec = (v: unknown): number[] | null =>
  typeof v === 'number'
    ? [v]
    : Array.isArray(v) || ArrayBuffer.isView(v)
      ? Array.from(v as ArrayLike<number>)
      : null

const ownText = (el: Element): boolean => {
  for (const n of el.childNodes) {
    if (n.nodeType === 3 && n.textContent?.trim()) {
      return true
    }
  }
  return false
}

const countOf = (sel: string): number => {
  try {
    return document.querySelectorAll(sel).length
  } catch {
    return 0
  }
}

const isEl = (s: Selection | null): s is { el: Element } =>
  s !== null && 'el' in s

export class EditView {
  readonly root = h('div', { class: 'edit' })
  private readonly pickBtn = h('button', {
    class: 'btn',
    type: 'button',
    text: 'Pick',
    title: 'Pick an element on the page (E)'
  })
  private readonly undoBtn = h('button', {
    class: 'btn',
    type: 'button',
    text: 'Undo',
    title: 'Undo (⌘Z)'
  })
  private readonly redoBtn = h('button', {
    class: 'btn',
    type: 'button',
    text: 'Redo',
    title: 'Redo (⇧⌘Z)'
  })
  private readonly copyBtn = h('button', {
    class: 'btn',
    type: 'button',
    text: 'Copy config',
    title: 'Copy the config as JSON'
  })
  private readonly livePicker = h('select', { 'aria-label': 'Config' })
  private readonly fileChip = h('button', {
    class: 'chip file',
    type: 'button'
  })
  private readonly openBtn = h('button', { class: 'btn', type: 'button' })
  private readonly saveBtn = h('button', {
    class: 'btn',
    type: 'button',
    title: 'Save (⌘S)'
  })
  private readonly saveAsBtn = h('button', {
    class: 'btn',
    type: 'button',
    text: 'Save as…'
  })
  private readonly autoBox = h('input', {
    type: 'checkbox',
    title: 'Write the file 300 ms after each change'
  })
  private readonly banner = h('div', { class: 'banner' })
  private readonly store = new FileStore()
  private dirty = false
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private restored: Promise<void> | null = null
  private readonly list = h('div', { class: 'layers' })
  private readonly inspector = h('div', { class: 'inspector' })
  private readonly overlay = h('div', { class: 'pick-overlay' })
  private readonly hoverBox = h('div', { class: 'outline pick' }, h('span'))
  private readonly selBox = h('div', { class: 'outline sel' }, h('span'))
  private mods: Mods | null = null
  private loading: Promise<void> | null = null
  private shown = false
  private picking = false
  private hovered: Element | null = null
  private point: [number, number] | null = null
  /** Ancestor steps from the candidate while picking ([ and ]). */
  private depth = 0
  private sel: Selection | null = null
  private liveIndex = 0
  private readonly history = new History()
  private timer: ReturnType<typeof setInterval> | undefined
  private listKey = ''
  private inspectKey = ''
  /** Param rows showing live values, refreshed in place. */
  private liveRows: {
    handle: ConfigInstance['handle']
    key: string
    live(v: unknown): void
  }[] = []

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
    this.undoBtn.addEventListener('click', () => this.undo())
    this.redoBtn.addEventListener('click', () => this.redo())
    this.copyBtn.addEventListener('click', () => {
      const live = this.live()
      if (live) {
        this.copy(JSON.stringify(live.config, null, 2), 'the config')
      }
    })
    this.livePicker.addEventListener('change', () => {
      this.liveIndex = Number(this.livePicker.value)
      this.refresh(true)
    })
    this.openBtn.textContent = this.store.supported ? 'Open…' : 'Upload…'
    this.saveBtn.textContent = this.store.supported ? 'Save' : 'Download'
    this.saveAsBtn.hidden = !this.store.supported
    this.autoBox.checked = this.autosave
    this.autoBox.addEventListener('change', () => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, this.autoBox.checked ? '1' : '0')
      } catch {
        // Storage blocked: for this page only.
      }
      if (this.autoBox.checked && this.dirty) {
        this.scheduleSave()
      }
    })
    this.openBtn.addEventListener('click', () => void this.openFile())
    this.saveBtn.addEventListener('click', () => void this.save())
    this.saveAsBtn.addEventListener('click', () => void this.saveAs())
    this.fileChip.addEventListener('click', () => void this.allow())
    this.banner.hidden = true
    this.root.append(
      h(
        'div',
        { class: 'bar' },
        this.pickBtn,
        this.undoBtn,
        this.redoBtn,
        this.livePicker,
        h('span', { class: 'sep' }),
        this.fileChip,
        this.openBtn,
        this.saveBtn,
        this.saveAsBtn,
        h(
          'label',
          { class: 'tf' },
          this.autoBox,
          h('span', { text: 'autosave' })
        ),
        this.copyBtn,
        h('span', {
          class: 'dim',
          text: 'E picks ([ ] ancestors, Esc stops); ⌘S saves.'
        })
      ),
      this.banner,
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
      if (!this.hovered) {
        // A click with no move before it (a tap, a script).
        this.point = [e.clientX, e.clientY]
        this.updateHover()
      }
      if (this.hovered) {
        this.select({ el: this.hovered })
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
    this.loading ??= Promise.all([
      import('../fx/config'),
      import('../fx/registry'),
      import('../fx/effects')
    ]).then(([config, registry, effects]) => {
      this.mods = { config, registry, effects }
    })
    void this.loading.then(() => {
      this.refresh(true)
      this.restored ??= this.restore()
    })
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

  /** Keys while the tab shows (not typing); true when handled. */
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
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) {
        this.redo()
      } else {
        this.undo()
      }
      return true
    }
    if (mod && e.key.toLowerCase() === 's') {
      void this.save()
      return true
    }
    if (mod && e.key.toLowerCase() === 'y') {
      this.redo()
      return true
    }
    if (inPanel && !mod && (e.key === 'e' || e.key === 'E')) {
      this.setPicking(true)
      return true
    }
    return false
  }

  destroy(): void {
    clearTimeout(this.saveTimer)
    if (this.dirty && this.store.state === 'ready') {
      void this.write()
    }
    this.hide()
    this.overlay.remove()
    this.hoverBox.remove()
    this.selBox.remove()
  }

  private readonly onScroll = (): void => {
    this.place(this.selBox, isEl(this.sel) ? this.sel.el : null)
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
    return this.mods?.config.liveConfigs() ?? []
  }

  private live(): LiveConfig | null {
    const ls = this.lives()
    return ls[Math.min(this.liveIndex, ls.length - 1)] ?? null
  }

  private instances(): ConfigInstance[] {
    return this.live()?.instances() ?? []
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

  // Editing.

  private commit(next: FxConfig, coalesce?: string): void {
    const live = this.live()
    if (!live) {
      return
    }
    this.history.push(live.config, coalesce, performance.now())
    live.update(next)
    this.changed()
  }

  private undo(): void {
    const live = this.live()
    const prev = live && this.history.undo(live.config)
    if (live && prev) {
      live.update(prev)
      this.changed()
      this.refresh(true)
    }
  }

  private redo(): void {
    const live = this.live()
    const next = live && this.history.redo(live.config)
    if (live && next) {
      live.update(next)
      this.changed()
      this.refresh(true)
    }
  }

  private syncButtons(): void {
    const live = this.live()
    this.undoBtn.disabled = !this.history.canUndo
    this.redoBtn.disabled = !this.history.canRedo
    this.copyBtn.disabled = !live
    this.saveBtn.disabled = !live
    this.saveAsBtn.disabled = !live
    this.openBtn.disabled = !live
    const st = this.store.state
    const name = this.store.name ?? ''
    this.fileChip.textContent =
      st === 'none'
        ? this.dirty
          ? 'No file · unsaved'
          : 'No file'
        : st === 'needs-permission'
          ? `${name} · click to allow writing`
          : `${name} · ${this.dirty ? 'unsaved' : 'saved'}`
    this.fileChip.classList.toggle('dead', st === 'none')
    this.fileChip.classList.toggle('dirty', this.dirty)
    this.fileChip.title =
      st === 'needs-permission'
        ? 'The browser asks again after a reload'
        : st === 'ready'
          ? 'The file the edits are written to'
          : 'Open or Save as to choose a file'
  }

  // Saving.

  private get autosave(): boolean {
    try {
      return localStorage.getItem(AUTOSAVE_KEY) !== '0'
    } catch {
      return true
    }
  }

  /** After every change: a draft, then the file (autosave). */
  private changed(): void {
    const live = this.live()
    this.dirty = true
    if (live) {
      this.store.saveDraft(live.config)
    }
    if (this.autoBox.checked && this.store.state === 'ready') {
      this.scheduleSave()
    }
    this.syncButtons()
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.write(), AUTOSAVE_MS)
  }

  private async write(): Promise<boolean> {
    const live = this.live()
    if (!live) {
      return false
    }
    const ok = await this.store.write(live.config)
    if (ok) {
      this.dirty = false
    } else {
      this.status(`Couldn’t write ${this.store.name ?? 'the file'}.`)
    }
    this.syncButtons()
    return ok
  }

  private async save(): Promise<void> {
    const live = this.live()
    if (!live) {
      return
    }
    clearTimeout(this.saveTimer)
    if (!this.store.supported) {
      download(live.config)
      this.dirty = false
      this.store.clearDraft()
      this.syncButtons()
      return
    }
    if (this.store.state === 'none') {
      await this.saveAs()
      return
    }
    if (
      this.store.state === 'needs-permission' &&
      !(await this.store.grant())
    ) {
      this.syncButtons()
      return
    }
    if (await this.write()) {
      this.status(`Saved ${this.store.name}.`)
    }
  }

  private async saveAs(): Promise<void> {
    const live = this.live()
    if (live && (await this.store.saveAs(live.config))) {
      this.dirty = false
      this.clearBanner()
      this.status(`Saved ${this.store.name}.`)
    }
    this.syncButtons()
  }

  private async openFile(): Promise<void> {
    try {
      const c = this.store.supported ? await this.store.open() : await upload()
      if (c) {
        this.offerFile(c, this.store.name ?? 'The file')
      }
    } catch (e) {
      this.status(`Not a config: ${(e as Error).message}`)
    }
    this.syncButtons()
  }

  /** Click on the file chip: write access again after a reload. */
  private async allow(): Promise<void> {
    if (this.store.state !== 'needs-permission') {
      return
    }
    if (await this.store.grant()) {
      await this.compareFile()
    }
    this.syncButtons()
  }

  /** On first show: the remembered file, then any draft. */
  private async restore(): Promise<void> {
    await this.store.restore()
    const live = this.live()
    const d = this.store.draft()
    if (live && d) {
      const diff = describeDiff(diffConfigs(live.config, d.config))
      if (diff) {
        const at = new Date(d.at).toLocaleTimeString()
        this.showBanner(`Unsaved edits from ${at} (${diff}).`, {
          Restore: () => {
            this.commit(d.config)
            this.refresh(true)
          },
          Discard: () => this.store.clearDraft()
        })
      } else {
        this.store.clearDraft()
      }
    }
    if (this.store.state === 'ready' && !d) {
      await this.compareFile()
    }
    this.syncButtons()
  }

  private async compareFile(): Promise<void> {
    try {
      const c = await this.store.read()
      if (c) {
        this.offerFile(c, this.store.name ?? 'The file')
      }
    } catch (e) {
      this.status(`${this.store.name}: ${(e as Error).message}`)
    }
  }

  /** `c` was read from a file: use it, or keep the page's (written over
   * the file on the next save). */
  private offerFile(c: FxConfig, name: string): void {
    const live = this.live()
    if (!live) {
      return
    }
    const diff = describeDiff(diffConfigs(live.config, c))
    if (!diff) {
      this.dirty = false
      this.clearBanner()
      return
    }
    this.showBanner(`${name} differs from the page (${diff}).`, {
      'Use the file': () => {
        this.commit(c)
        this.dirty = false
        this.store.clearDraft()
        this.syncButtons()
        this.refresh(true)
      },
      'Keep the page': () => {
        this.dirty = true
        if (this.autoBox.checked && this.store.state === 'ready') {
          this.scheduleSave()
        }
        this.syncButtons()
      }
    })
  }

  private showBanner(text: string, actions: Record<string, () => void>): void {
    this.banner.replaceChildren(
      h('span', { text }),
      ...Object.entries(actions).map(([label, run]) => {
        const b = h('button', { class: 'btn', type: 'button', text: label })
        b.addEventListener('click', () => {
          this.clearBanner()
          run()
        })
        return b
      })
    )
    this.banner.hidden = false
  }

  private clearBanner(): void {
    this.banner.hidden = true
    this.banner.replaceChildren()
  }

  private matchFor(el: Element): Match {
    const fx = el.getAttribute('data-fx')
    return fx ? { fx } : { selector: selectorFor(el, countOf) }
  }

  private add(def: EffectDef, el: Element | null): void {
    const live = this.live()
    if (!live) {
      return
    }
    const id = uniqueId(
      live.config,
      el ? `${suggestName(el)}-${def.id}` : def.id
    )
    this.commit(
      addEffect(live.config, el ? this.matchFor(el) : null, def.id, id)
    )
    if (!el) {
      this.sel = { page: id }
    }
    this.refresh(true)
  }

  private startConfig(): void {
    const m = this.mods
    if (!m) {
      return
    }
    m.config.applyConfig(m.effects.createEffects(this.compositor), {
      version: 1
    })
    this.liveIndex = m.config.liveConfigs().length - 1
    this.refresh(true)
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

  // Rendering.

  private select(s: Selection | null): void {
    this.sel = s
    this.place(this.selBox, isEl(s) ? s.el : null, isEl(s) ? labelOf(s.el) : '')
    this.refresh(true)
  }

  private refresh(force = false): void {
    if (!this.shown) {
      return
    }
    if (isEl(this.sel) && !this.sel.el.isConnected) {
      this.sel = null
    }
    this.place(this.selBox, isEl(this.sel) ? this.sel.el : null)
    this.renderBar()
    this.renderList(force)
    this.renderInspector(force)
    for (const r of this.liveRows) {
      r.live(r.handle.params[r.key])
    }
  }

  private renderBar(): void {
    const ls = this.lives()
    this.livePicker.hidden = ls.length < 2
    const opts = ls.map((_, i) => `config ${i + 1}`)
    if (this.livePicker.options.length !== opts.length) {
      this.livePicker.replaceChildren(
        ...opts.map((t, i) =>
          h('option', { value: i, text: t, selected: i === this.liveIndex })
        )
      )
    }
    this.syncButtons()
  }

  private row(
    label: string,
    chips: string[],
    opts: { dim?: boolean; on?: boolean; pick: () => void; el?: Element }
  ): HTMLElement {
    const b = h(
      'button',
      {
        class: `row${opts.dim ? ' dimrow' : ''}${opts.on ? ' on' : ''}`,
        type: 'button'
      },
      h('span', { class: 'rl', text: label }),
      ...chips.map((c) => h('span', { class: 'kind', text: c }))
    )
    b.addEventListener('click', opts.pick)
    const el = opts.el
    if (el) {
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

  private addPicker(
    scope: 'page' | 'element',
    el: Element | null
  ): HTMLElement {
    const defs = (this.mods?.registry.listEffects() ?? []).filter((d) =>
      d.scopes.includes(scope)
    )
    const pick = h(
      'select',
      { 'aria-label': 'Effect to add' },
      ...defs.map((d) => h('option', { value: d.id, text: d.label }))
    )
    const add = h('button', { class: 'btn', type: 'button', text: 'Add' })
    add.addEventListener('click', () => {
      const def = defs.find((d) => d.id === pick.value)
      if (def) {
        this.add(def, el)
      }
    })
    return h('div', { class: 'addfx' }, pick, add)
  }

  private renderList(force: boolean): void {
    const live = this.live()
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
      isEl(this.sel) ? els.indexOf(this.sel.el) : this.sel?.page,
      this.mods !== null,
      live !== null
    ])
    if (!force && key === this.listKey) {
      return
    }
    this.listKey = key
    const kids: HTMLElement[] = []
    if (this.mods && !live) {
      const start = h('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Start a config'
      })
      start.addEventListener('click', () => this.startConfig())
      kids.push(
        h('p', { class: 'dim', text: 'No applyConfig on this page.' }),
        start
      )
    }
    if (live) {
      kids.push(h('h3', { text: 'Page effects' }))
      for (const i of page) {
        kids.push(
          this.row(i.id, [i.effect, i.handle.enabled ? 'on' : 'off'], {
            dim: !i.handle.enabled,
            on: !isEl(this.sel) && this.sel?.page === i.id,
            pick: () => this.select({ page: i.id })
          })
        )
      }
      kids.push(this.addPicker('page', null))
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
          this.row(labelOf(el), [...r.fx, ...r.kinds], {
            dim: !r.config,
            on: isEl(this.sel) && el === this.sel.el,
            el,
            pick: () => {
              this.select({ el })
              const b = el.getBoundingClientRect()
              if (b.bottom < 0 || b.top > window.innerHeight) {
                el.scrollIntoView({ block: 'center' })
              }
            }
          })
        )
      }
    }
    this.list.replaceChildren(...kids)
  }

  private renderInspector(force: boolean): void {
    const sel = this.sel
    const live = this.live()
    const insts = this.instances().filter((i) =>
      isEl(sel) ? i.el === sel.el : i.el === null && i.id === sel?.page
    )
    const el = isEl(sel) ? sel.el : null
    const info = el ? this.inspected().find((i) => i.el === el) : undefined
    const key = JSON.stringify([
      el ? labelOf(el) : sel,
      info?.kinds,
      info?.materials,
      insts.map((i) => [i.cfg, i.handle.enabled]),
      live?.version,
      this.mods !== null
    ])
    const focused = this.inspector.contains(
      (this.host.shadowRoot?.activeElement as Node | null) ?? null
    )
    if (!force && (key === this.inspectKey || focused)) {
      return
    }
    this.inspectKey = key
    this.liveRows = []
    if (!sel) {
      this.inspector.replaceChildren(
        h('p', {
          class: 'empty',
          text: 'Pick an element (E) or choose one from the list.'
        })
      )
      return
    }
    const parts: HTMLElement[] = []
    if (el) {
      parts.push(...this.elementInfo(el, info))
      parts.push(h('h3', { text: 'Config effects' }))
      if (!this.mods) {
        parts.push(h('p', { class: 'dim', text: 'Loading the config module…' }))
      } else if (!live) {
        parts.push(
          h('p', {
            class: 'dim',
            text: 'No applyConfig on this page: Start a config in the list.'
          })
        )
      } else if (insts.length === 0) {
        parts.push(h('p', { class: 'dim', text: 'None on this element.' }))
      }
    }
    // One card per effect id (a selector can create several instances).
    const seen = new Set<string>()
    for (const i of insts) {
      if (!seen.has(i.id)) {
        seen.add(i.id)
        parts.push(
          this.effectCard(i, insts.filter((x) => x.id === i.id).length)
        )
      }
    }
    if (el && live) {
      parts.push(this.addPicker('element', el))
    }
    if (!el && insts.length === 0) {
      parts.push(h('p', { class: 'dim', text: 'That effect is gone.' }))
    }
    this.inspector.replaceChildren(...parts)
  }

  private elementInfo(
    el: Element,
    info: InspectedElement | undefined
  ): HTMLElement[] {
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
          h('code', { text: selectorFor(el, countOf) }),
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
    const out = [
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
      out.push(kv('materials', info.materials.join(', ')))
    }
    return out
  }

  private effectCard(i: ConfigInstance, copies: number): HTMLElement {
    const live = this.live()
    const def = this.mods?.registry.getEffect(i.effect)
    const cfg = live ? findEffect(live.config, i.id)?.effect : undefined
    const now = (): FxConfig | null => this.live()?.config ?? null
    const enabled = h('input', {
      type: 'checkbox',
      checked: cfg?.enabled ?? true,
      title: 'Enabled at rest'
    })
    enabled.addEventListener('change', () => {
      const c = now()
      if (c) {
        this.commit(setEnabled(c, i.id, enabled.checked))
      }
    })
    const media = h('input', {
      type: 'text',
      class: 'media',
      placeholder: 'media query (any)',
      value: cfg?.media ?? '',
      title: 'Only while this media query matches'
    })
    media.addEventListener('change', () => {
      const c = now()
      if (c) {
        this.commit(setMedia(c, i.id, media.value))
      }
    })
    const remove = h('button', {
      class: 'btn',
      type: 'button',
      text: 'Remove'
    })
    remove.addEventListener('click', () => {
      const c = now()
      if (c) {
        this.commit(removeEffect(c, i.id))
        this.refresh(true)
      }
    })
    const params: HTMLElement[] = []
    for (const [key, pd] of Object.entries(def?.schema ?? {})) {
      const value = cfg?.params?.[key]
      const shown =
        (value !== undefined && def
          ? this.mods?.config.paramVec(def.schema, key, value)
          : null) ??
        toVec(i.handle.params[key]) ??
        []
      const r = paramRow(key, pd, value, shown, (v, done) => {
        const c = now()
        if (!c) {
          return
        }
        this.commit(
          setParam(c, i.id, key, v as ParamInput | undefined),
          `${i.id}.${key}`
        )
        if (done && v === undefined) {
          this.refresh(true)
        }
      })
      this.liveRows.push({ handle: i.handle, key, live: r.live })
      params.push(r.row)
    }
    const triggers = (cfg?.triggers ?? []).map((t, n) =>
      triggerRow(
        t,
        (next) => {
          const c = now()
          if (c) {
            this.commit(setTrigger(c, i.id, n, next))
          }
        },
        () => this.live()?.fire(i.id, n, { fromRest: true }),
        () => {
          const c = now()
          if (c) {
            this.commit(setTrigger(c, i.id, n, null))
            this.refresh(true)
          }
        }
      )
    )
    const addTrigger = h('button', {
      class: 'btn',
      type: 'button',
      text: 'Add trigger'
    })
    addTrigger.addEventListener('click', () => {
      const c = now()
      if (c) {
        this.commit(
          setTrigger(c, i.id, cfg?.triggers?.length ?? 0, {
            on: 'pointerenter',
            to: 'rest'
          })
        )
        this.refresh(true)
      }
    })
    return h(
      'div',
      { class: 'factor' },
      h(
        'div',
        { class: 'fhead' },
        enabled,
        h('strong', { text: i.id }),
        h('span', { class: 'kind', text: i.effect }),
        copies > 1
          ? h('span', { class: 'dim', text: `on ${copies} elements` })
          : null,
        h('span', { class: 'spacer' }),
        media,
        remove
      ),
      def
        ? h('div', { class: 'params' }, ...params)
        : h('p', {
            class: 'note',
            text: `No registered effect '${i.effect}'.`
          }),
      h('div', { class: 'dim', text: 'Triggers' }),
      ...triggers,
      addTrigger
    )
  }

  private copy(text: string, what: string): void {
    void navigator.clipboard?.writeText(text).then(
      () => this.status(`Copied ${what}.`),
      () => this.status(`Couldn’t copy ${what}.`)
    )
  }

  private copyButton(text: string): HTMLElement {
    const b = h('button', {
      class: 'btn',
      type: 'button',
      text: 'Copy data-fx',
      title: `Copy ${text} to paste into the markup`
    })
    b.addEventListener('click', () => this.copy(text, text))
    return b
  }
}
