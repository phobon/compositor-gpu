// `compositor-gpu/editor` (docs/EDITOR.md): edit the page's effects on
// the page itself. While open, clicks select (hold Space, or Preview, to
// use the page); the selection gets a popover inspector beside it; ⌘K
// lists the page effects, composited elements and actions. Edits go to
// the page's config (fx/config.ts) and its file (store.ts).
//
// Opens with `?edit` in the URL, ⌥E, or the devtools' Edit page button.
// One editor per compositor (mountEditor is memoised). The UI sits in a
// shadow root on <html> marked data-gpu-ignore, above the canvas.

import type { Compositor } from '../types'
import { h } from '../util/h'
import { addPicker, effectCard, type LiveRow } from './cards'
import { CSS } from './css'
import { icon } from './icons'
import { labelOf, selectorFor, suggestName } from './pick'
import { type Banner, countOf, EditSession } from './session'

export interface EditorOptions {
  /** Open now: default when the URL has `?edit` (not `?edit=0`). */
  open?: boolean
  /** The toggle, e.g. 'Alt+E' (the default); false: none. */
  shortcut?: string | false
}

export interface Editor {
  open(): void
  close(): void
  toggle(): void
  readonly isOpen: boolean
  destroy(): void
}

/** The element picked, or a page effect chosen in the palette. */
type Selection = { el: Element } | { page: string }

const isEl = (s: Selection | null): s is { el: Element } =>
  s !== null && 'el' in s

const MEDIA = new Set(['IMG', 'SVG', 'svg', 'CANVAS', 'VIDEO', 'PICTURE'])
const REFRESH_MS = 500
const POP_W = 360

const ownText = (el: Element): boolean => {
  for (const n of el.childNodes) {
    if (n.nodeType === 3 && n.textContent?.trim()) {
      return true
    }
  }
  return false
}

const typingIn = (e: Event): boolean => {
  const t = e.composedPath()[0]
  return (
    t instanceof HTMLElement &&
    (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
  )
}

function matchShortcut(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.toLowerCase().split('+')
  const key = parts.pop()
  return (
    e.code.toLowerCase() === `key${key}` &&
    e.altKey === parts.includes('alt') &&
    e.shiftKey === parts.includes('shift') &&
    (e.ctrlKey || e.metaKey) ===
      (parts.includes('ctrl') ||
        parts.includes('meta') ||
        parts.includes('mod'))
  )
}

const editors = new WeakMap<Compositor, Editor>()

const inert: Editor = {
  open() {},
  close() {},
  toggle() {},
  isOpen: false,
  destroy() {}
}

/** The editor for `compositor` (one per compositor; inert on the
 * server). */
export function mountEditor(
  compositor: Compositor,
  opts: EditorOptions = {}
): Editor {
  if (typeof window === 'undefined') {
    return inert
  }
  const had = editors.get(compositor)
  if (had) {
    if (opts.open) {
      had.open()
    }
    return had
  }
  const ed = new OnPageEditor(compositor, opts)
  editors.set(compositor, ed)
  return ed
}

interface PalItem {
  group: string
  label: string
  chips?: string[]
  el?: Element
  run(): void
}

class OnPageEditor implements Editor {
  private readonly s: EditSession
  private readonly host = document.createElement('div')
  private readonly ui = h('div', { class: 'ed' })
  private readonly catcher = h('div', { class: 'catch' })
  private readonly hoverBox = h('div', { class: 'box hover' }, h('span'))
  private readonly selBox = h('div', { class: 'box sel' }, h('span'))
  private readonly marks = h('div')
  private readonly toolbar = h('div', { class: 'toolbar' })
  private readonly selectBtn = h(
    'button',
    {
      class: 'tab',
      type: 'button',
      title: 'Clicks select (hold Space to use the page)'
    },
    icon('pointer', 14),
    'Select'
  )
  private readonly previewBtn = h(
    'button',
    {
      class: 'tab',
      type: 'button',
      title: 'Use the page: hovers and clicks reach it (hold Space)'
    },
    icon('eye', 14),
    'Preview'
  )
  private readonly fileDot = h('span', { class: 'dot' })
  private readonly fileText = h('span', { class: 'ft' })
  private readonly fileBtn = h(
    'button',
    { class: 'file', type: 'button' },
    this.fileDot,
    this.fileText
  )
  private readonly saveBtn = h('button', {
    class: 'btn secondary sm',
    type: 'button',
    text: 'Save',
    title: 'Save (⌘S)'
  })
  private readonly undoBtn = h(
    'button',
    {
      class: 'btn ghost icon',
      type: 'button',
      title: 'Undo (⌘Z)',
      'aria-label': 'Undo'
    },
    icon('undo')
  )
  private readonly redoBtn = h(
    'button',
    {
      class: 'btn ghost icon',
      type: 'button',
      title: 'Redo (⇧⌘Z)',
      'aria-label': 'Redo'
    },
    icon('redo')
  )
  private readonly moreBtn = h(
    'button',
    {
      class: 'btn ghost icon',
      type: 'button',
      title: 'More',
      'aria-label': 'More'
    },
    icon('more')
  )
  private readonly menu = h('div', { class: 'menu' })
  private readonly banner = h('div', { class: 'banner' })
  private readonly toast = h('div', { class: 'toast' })
  private readonly pop = h('div', { class: 'pop' })
  private readonly pal = h('div', { class: 'pal' })
  private readonly palInput = h('input', {
    type: 'text',
    placeholder: 'Search elements, effects and actions…',
    'aria-label': 'Search'
  })
  private readonly palList = h('ul', { role: 'listbox' })
  private palItems: PalItem[] = []
  private palIndex = 0
  private opened = false
  private preview = false
  private spaceHeld = false
  private point: [number, number] | null = null
  private depth = 0
  private hovered: Element | null = null
  private sel: Selection | null = null
  /** Cards open by effect id (the first of a selection opens). */
  private readonly openCards = new Set<string>()
  private popKey = ''
  /** The selection changed since the popover was built. */
  private freshSel = false
  private liveRows: LiveRow[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  private readonly shortcut: string | false

  constructor(
    private readonly compositor: Compositor,
    opts: EditorOptions
  ) {
    this.s = new EditSession(compositor)
    this.shortcut = opts.shortcut ?? 'Alt+E'
    this.s.status = (t) => this.say(t)
    this.s.banner = (b) => this.showBanner(b)
    this.s.onChange(() => this.refresh())

    this.host.setAttribute('data-gpu-ignore', '')
    this.host.setAttribute('data-compositor-editor', '')
    const shadow = this.host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = CSS
    this.ui.hidden = true
    for (const el of [
      this.hoverBox,
      this.menu,
      this.banner,
      this.toast,
      this.pop,
      this.pal
    ]) {
      el.hidden = true
    }
    this.selBox.hidden = true
    this.buildToolbar()
    const kbd = (k: string) => h('kbd', { text: k })
    this.pal.append(
      h('div', { class: 'psearch' }, icon('search'), this.palInput),
      this.palList,
      h(
        'div',
        { class: 'pfoot' },
        kbd('↑'),
        kbd('↓'),
        h('span', { text: 'to move' }),
        kbd('↵'),
        h('span', { text: 'to choose' }),
        kbd('esc'),
        h('span', { text: 'to close' })
      )
    )
    this.ui.append(
      this.catcher,
      this.marks,
      this.hoverBox,
      this.selBox,
      this.toolbar,
      this.pop,
      this.menu,
      this.banner,
      this.pal,
      this.toast
    )
    shadow.append(style, this.ui)
    document.documentElement.append(this.host)

    this.catcher.addEventListener('pointermove', (e) => {
      this.point = [e.clientX, e.clientY]
      this.depth = 0
      this.updateHover()
    })
    this.catcher.addEventListener('pointerleave', () => {
      this.point = null
      this.hovered = null
      this.hoverBox.hidden = true
    })
    this.catcher.addEventListener('click', (e) => {
      e.preventDefault()
      this.point = [e.clientX, e.clientY]
      if (!this.hovered) {
        this.updateHover()
      }
      this.select(this.hovered ? { el: this.hovered } : null)
    })
    this.catcher.addEventListener(
      'wheel',
      (e) => {
        if (e.altKey) {
          e.preventDefault()
          this.step(e.deltaY < 0 ? 1 : -1)
        }
      },
      { passive: false }
    )
    this.palInput.addEventListener('input', () => {
      this.palIndex = 0
      this.renderPalette()
    })
    document.addEventListener('keydown', this.onKey, true)
    document.addEventListener('keyup', this.onKeyUp, true)
    window.addEventListener('scroll', this.onScroll, {
      passive: true,
      capture: true
    })
    window.addEventListener('resize', this.onScroll, { passive: true })

    const q = new URLSearchParams(location.search)
    if (opts.open ?? (q.has('edit') && q.get('edit') !== '0')) {
      this.open()
    }
  }

  get isOpen(): boolean {
    return this.opened
  }

  open(): void {
    if (this.opened) {
      return
    }
    this.opened = true
    this.ui.hidden = false
    void this.s.load()
    this.timer = setInterval(() => this.refresh(), REFRESH_MS)
    this.refresh(true)
  }

  close(): void {
    if (!this.opened) {
      return
    }
    this.opened = false
    this.s.flush()
    this.ui.hidden = true
    this.closePalette()
    this.menu.hidden = true
    clearInterval(this.timer)
  }

  toggle(): void {
    if (this.opened) {
      this.close()
    } else {
      this.open()
    }
  }

  destroy(): void {
    this.close()
    document.removeEventListener('keydown', this.onKey, true)
    document.removeEventListener('keyup', this.onKeyUp, true)
    window.removeEventListener('scroll', this.onScroll, true)
    window.removeEventListener('resize', this.onScroll)
    this.host.remove()
    editors.delete(this.compositor)
  }

  // Toolbar.

  private buildToolbar(): void {
    const seg = h(
      'span',
      { class: 'tabs', role: 'group', 'aria-label': 'Mode' },
      this.selectBtn,
      this.previewBtn
    )
    this.selectBtn.addEventListener('click', () => this.setPreview(false))
    this.previewBtn.addEventListener('click', () => this.setPreview(true))
    const layers = h(
      'button',
      {
        class: 'btn ghost sm',
        type: 'button',
        title: 'Elements, page effects and actions (⌘K)'
      },
      icon('search', 14),
      'Find',
      h('kbd', { text: '⌘K' })
    )
    layers.addEventListener('click', () => this.openPalette())
    const close = h(
      'button',
      {
        class: 'btn ghost icon',
        type: 'button',
        title: 'Close the editor (⌥E)',
        'aria-label': 'Close the editor'
      },
      icon('x')
    )
    close.addEventListener('click', () => this.close())
    this.fileBtn.addEventListener('click', () => {
      if (this.s.store.state === 'needs-permission') {
        void this.s.allow()
      } else {
        void this.s.save()
      }
    })
    this.saveBtn.addEventListener('click', () => void this.s.save())
    this.undoBtn.addEventListener('click', () => this.s.undo())
    this.redoBtn.addEventListener('click', () => this.s.redo())
    this.moreBtn.addEventListener('click', () => this.toggleMenu())
    this.toolbar.append(
      h('span', { class: 'brand' }, icon('layers', 14), 'Effects'),
      h('span', { class: 'sep' }),
      seg,
      layers,
      h('span', { class: 'sep' }),
      this.undoBtn,
      this.redoBtn,
      h('span', { class: 'sep' }),
      this.fileBtn,
      this.saveBtn,
      this.moreBtn,
      close
    )
    this.setPreview(false)
  }

  private toggleMenu(): void {
    if (!this.menu.hidden) {
      this.menu.hidden = true
      return
    }
    const item = (
      name: Parameters<typeof icon>[0],
      text: string,
      run: () => void,
      hint?: string
    ): HTMLElement => {
      const b = h(
        'button',
        { type: 'button', role: 'menuitem' },
        icon(name, 14),
        h('span', { text }),
        hint ? h('span', { class: 'hint', text: hint }) : null
      )
      b.addEventListener('click', () => {
        this.menu.hidden = true
        run()
      })
      return b
    }
    const auto = h(
      'button',
      {
        type: 'button',
        role: 'menuitemcheckbox',
        'aria-checked': this.s.autosave
      },
      this.s.autosave ? icon('check', 14) : h('span', { class: 'i' }),
      h('span', { text: 'Autosave' })
    )
    auto.addEventListener('click', () => {
      this.s.autosave = !this.s.autosave
      this.menu.hidden = true
    })
    const live = this.s.live()
    this.menu.replaceChildren(
      h('div', { class: 'mlabel', text: 'File' }),
      item(
        'folder',
        this.s.store.supported ? 'Open…' : 'Upload…',
        () => void this.s.openFile()
      ),
      ...(this.s.store.supported
        ? [item('download', 'Save as…', () => void this.s.saveAs())]
        : []),
      auto,
      h('div', { class: 'msep' }),
      ...(live
        ? [
            item('copy', 'Copy config', () => {
              void navigator.clipboard
                ?.writeText(JSON.stringify(live.config, null, 2))
                .then(() => this.say('Copied the config.'))
            })
          ]
        : [])
    )
    const r = this.moreBtn.getBoundingClientRect()
    Object.assign(this.menu.style, {
      top: `${r.bottom + 6}px`,
      left: `${Math.max(8, r.right - 200)}px`
    })
    this.menu.hidden = false
  }

  private setPreview(on: boolean): void {
    this.preview = on
    this.ui.classList.toggle('preview', on)
    this.selectBtn.setAttribute('aria-pressed', String(!on))
    this.previewBtn.setAttribute('aria-pressed', String(on))
    if (on) {
      this.hovered = null
      this.hoverBox.hidden = true
    }
  }

  private syncToolbar(): void {
    const live = this.s.live()
    const f = this.s.fileLabel()
    this.fileText.textContent = f.text
    this.fileBtn.title = f.title
    const st = this.s.store.state
    this.fileDot.className = `dot ${
      st === 'needs-permission'
        ? 'warn'
        : this.s.dirty
          ? 'dirty'
          : st === 'ready'
            ? 'ok'
            : ''
    }`
    this.saveBtn.disabled = !live
    this.undoBtn.disabled = !this.s.history.canUndo
    this.redoBtn.disabled = !this.s.history.canRedo
  }

  private showBanner(b: Banner | null): void {
    if (!b) {
      this.banner.hidden = true
      this.banner.replaceChildren()
      return
    }
    this.banner.replaceChildren(
      icon('info'),
      h('span', { class: 'bt', text: b.text }),
      ...Object.entries(b.actions).map(([label, run], n) => {
        const btn = h('button', {
          class: `btn sm ${n === 0 ? 'primary' : 'secondary'}`,
          type: 'button',
          text: label
        })
        btn.addEventListener('click', () => {
          this.showBanner(null)
          run()
        })
        return btn
      })
    )
    this.banner.hidden = false
  }

  private say(text: string): void {
    if (!text) {
      return
    }
    this.toast.replaceChildren(icon('check', 14), h('span', { text }))
    this.toast.hidden = false
    clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => {
      this.toast.hidden = true
    }, 2500)
  }

  // Keys.

  private readonly onKey = (e: KeyboardEvent): void => {
    if (this.shortcut && matchShortcut(e, this.shortcut)) {
      e.preventDefault()
      this.toggle()
      return
    }
    if (!this.opened) {
      return
    }
    const mod = e.metaKey || e.ctrlKey
    const k = e.key.toLowerCase()
    if (mod && k === 'k') {
      e.preventDefault()
      if (this.pal.hidden) {
        this.openPalette()
      } else {
        this.closePalette()
      }
      return
    }
    if (mod && k === 's') {
      e.preventDefault()
      void this.s.save()
      return
    }
    if (!this.pal.hidden) {
      this.paletteKey(e)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (!this.menu.hidden) {
        this.menu.hidden = true
      } else if (this.sel) {
        this.select(null)
      } else {
        this.close()
      }
      return
    }
    if (typingIn(e)) {
      return
    }
    if (mod && k === 'z') {
      e.preventDefault()
      if (e.shiftKey) {
        this.s.redo()
      } else {
        this.s.undo()
      }
    } else if (mod && k === 'y') {
      e.preventDefault()
      this.s.redo()
    } else if (e.key === ' ' && !this.preview) {
      // Hold to use the page.
      e.preventDefault()
      if (!this.spaceHeld) {
        this.spaceHeld = true
        this.setPreview(true)
      }
    } else if (e.key === '[' && this.hovered) {
      this.step(1)
    } else if (e.key === ']' && this.hovered) {
      this.step(-1)
    }
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === ' ' && this.spaceHeld) {
      this.spaceHeld = false
      this.setPreview(false)
    }
  }

  private readonly onScroll = (): void => {
    if (!this.opened) {
      return
    }
    this.placeSelection()
    this.placeMarks()
    if (this.point && !this.preview) {
      this.updateHover()
    }
  }

  // Picking.

  private hit(x: number, y: number): Element | null {
    this.catcher.style.pointerEvents = 'none'
    const els = document.elementsFromPoint(x, y)
    this.catcher.style.pointerEvents = ''
    for (const el of els) {
      if (el === this.host || el.hasAttribute('data-compositor-devtools')) {
        return null
      }
      if (el !== this.compositor.canvas) {
        return el
      }
    }
    return null
  }

  private step(d: number): void {
    this.depth += d
    this.updateHover()
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
    const known = this.s.known()
    let i = chain.findIndex(
      (el) =>
        el.hasAttribute('data-fx') ||
        known.has(el) ||
        MEDIA.has(el.tagName) ||
        ownText(el)
    )
    if (i < 0) {
      i = 0
    }
    this.depth = Math.max(-i, Math.min(chain.length - 1 - i, this.depth))
    const el = chain[i + this.depth] ?? hit
    this.hovered = el
    this.place(this.hoverBox, el, this.describe(el))
  }

  private describe(el: Element): string {
    const kinds = this.s.inspected().find((i) => i.el === el)?.kinds ?? []
    const fx = this.s
      .instances()
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
    if (text !== undefined && box.firstElementChild) {
      box.firstElementChild.textContent = text
    }
    box.hidden = false
  }

  /** Dashed outlines on the elements that carry config effects. */
  private placeMarks(): void {
    const els = [
      ...new Set(
        this.s
          .instances()
          .map((i) => i.el)
          .filter((el): el is Element => el !== null)
      )
    ]
    while (this.marks.children.length < els.length) {
      this.marks.append(h('div', { class: 'box mark' }))
    }
    while (this.marks.children.length > els.length) {
      this.marks.lastElementChild?.remove()
    }
    els.forEach((el, i) => {
      this.place(this.marks.children[i] as HTMLElement, el)
    })
  }

  // Selection and its popover.

  private select(s: Selection | null): void {
    this.sel = s
    this.popKey = ''
    this.freshSel = true
    this.refresh(true)
  }

  private refresh(force = false): void {
    if (!this.opened) {
      return
    }
    if (isEl(this.sel) && !this.sel.el.isConnected) {
      this.sel = null
    }
    this.syncToolbar()
    this.placeMarks()
    this.renderPopover(force)
    this.placeSelection()
    for (const r of this.liveRows) {
      r.live(r.handle.params[r.key])
    }
  }

  private placeSelection(): void {
    const el = isEl(this.sel) ? this.sel.el : null
    this.place(this.selBox, el, el ? labelOf(el) : undefined)
    if (this.pop.hidden) {
      return
    }
    const vw = window.innerWidth
    const vh = window.innerHeight
    const ph = this.pop.offsetHeight
    let left: number
    let top: number
    if (el) {
      const r = el.getBoundingClientRect()
      left =
        r.right + 12 + POP_W <= vw - 8
          ? r.right + 12
          : r.left - 12 - POP_W >= 8
            ? r.left - 12 - POP_W
            : vw - POP_W - 12
      top = r.top
    } else {
      const t = this.toolbar.getBoundingClientRect()
      left = t.left + t.width / 2 - POP_W / 2
      top = t.bottom + 10
    }
    top = Math.max(60, Math.min(top, vh - ph - 12))
    Object.assign(this.pop.style, {
      left: `${Math.max(8, left)}px`,
      top: `${top}px`
    })
  }

  private renderPopover(force: boolean): void {
    const sel = this.sel
    if (!sel) {
      this.pop.hidden = true
      this.liveRows = []
      return
    }
    const live = this.s.live()
    const el = isEl(sel) ? sel.el : null
    const pageId = isEl(sel) ? null : sel.page
    const insts = this.s
      .instances()
      .filter((i) => (el ? i.el === el : i.el === null && i.id === pageId))
    const info = el ? this.s.inspected().find((i) => i.el === el) : undefined
    const key = JSON.stringify([
      el ? labelOf(el) : sel,
      info?.kinds,
      insts.map((i) => [i.cfg, i.handle.enabled]),
      live?.version,
      this.s.mods !== null,
      live !== null
    ])
    const focused = this.pop.contains(
      (this.host.shadowRoot?.activeElement as Node | null) ?? null
    )
    if (!force && (key === this.popKey || focused)) {
      return
    }
    if (force && focused && key === this.popKey) {
      return
    }
    // Remember which cards are open before rebuilding.
    for (const d of this.pop.querySelectorAll<HTMLDetailsElement>(
      'details.card'
    )) {
      const id = d.dataset.id
      if (id) {
        if (d.open) {
          this.openCards.add(id)
        } else {
          this.openCards.delete(id)
        }
      }
    }
    this.popKey = key
    this.liveRows = []
    const close = h(
      'button',
      {
        class: 'btn ghost icon',
        type: 'button',
        title: 'Deselect (Esc)',
        'aria-label': 'Deselect'
      },
      icon('x')
    )
    close.addEventListener('click', () => this.select(null))
    const count = new Set(insts.map((i) => i.id)).size
    const parts: HTMLElement[] = [
      h(
        'div',
        { class: 'phead' },
        h(
          'div',
          { class: 'ptitle' },
          h('h3', { text: el ? labelOf(el, 48) : (pageId ?? '') }),
          h('p', {
            class: 'muted small',
            text: el
              ? `${count} effect${count === 1 ? '' : 's'}`
              : 'Page effect'
          })
        ),
        close
      )
    ]
    if (el) {
      const chips = [
        ...(info?.kinds ?? []).map((k) =>
          k === 'opacity' && info?.alpha !== undefined
            ? `opacity ${Number(info.alpha.toFixed(2))}`
            : k
        ),
        ...(info?.materials ?? [])
      ]
      parts.push(
        h(
          'div',
          { class: 'psec' },
          this.matchRow(el),
          h(
            'div',
            { class: 'field' },
            h(
              'div',
              { class: 'fl' },
              h('span', { class: 'flt', text: 'Composited' })
            ),
            h(
              'div',
              { class: 'fc wrap' },
              ...(chips.length
                ? chips.map((c) => h('span', { class: 'badge', text: c }))
                : [h('span', { class: 'muted', text: 'In its parent' })])
            )
          )
        )
      )
    }
    const body: HTMLElement[] = []
    let foot: HTMLElement | null = null
    if (!this.s.mods) {
      body.push(h('p', { class: 'empty', text: 'Loading…' }))
    } else if (!live) {
      const start = h('button', {
        class: 'btn primary',
        type: 'button',
        text: 'Start a config'
      })
      start.addEventListener('click', () => this.s.startConfig())
      body.push(
        h('p', { class: 'empty', text: 'No config on this page.' }),
        start
      )
    } else {
      const ids = [...new Set(insts.map((i) => i.id))]
      if (ids.length === 0) {
        body.push(
          h('p', {
            class: 'empty',
            text: el ? 'No effects on this element.' : 'That effect is gone.'
          })
        )
      }
      const first = ids[0]
      if (this.freshSel && first && !ids.some((x) => this.openCards.has(x))) {
        this.openCards.add(first)
      }
      this.freshSel = false
      for (const id of ids) {
        const i = insts.find((x) => x.id === id)
        if (!i) {
          continue
        }
        body.push(
          effectCard(this.s, i, {
            copies: insts.filter((x) => x.id === id).length,
            open: this.openCards.has(id),
            liveRows: this.liveRows,
            rebuild: () => this.refresh(true)
          })
        )
      }
      if (el) {
        foot = addPicker(this.s, 'element', el, (id) => {
          this.openCards.add(id)
          this.refresh(true)
        })
      }
    }
    parts.push(h('div', { class: 'psec fx' }, ...body))
    if (foot) {
      parts.push(h('div', { class: 'pfoot2' }, foot))
    }
    this.pop.replaceChildren(...parts)
    this.pop.hidden = false
  }

  private matchRow(el: Element): HTMLElement {
    const fx = el.getAttribute('data-fx')
    const row = (...ctl: (Node | string)[]): HTMLElement =>
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'fl' }, h('span', { class: 'flt', text: 'Match' })),
        h('div', { class: 'fc wrap' }, ...ctl)
      )
    if (fx) {
      return row(h('code', { class: 'code', text: `[data-fx="${fx}"]` }))
    }
    const attr = `data-fx="${suggestName(el)}"`
    const copy = h(
      'button',
      {
        class: 'btn ghost icon xs',
        type: 'button',
        title: `Copy ${attr} to paste into the markup`,
        'aria-label': 'Copy a data-fx attribute'
      },
      icon('copy', 12)
    )
    copy.addEventListener('click', () => {
      void navigator.clipboard
        ?.writeText(attr)
        .then(() => this.say(`Copied ${attr}`))
    })
    return row(
      h('code', { class: 'code', text: selectorFor(el, countOf) }),
      h('span', {
        class: 'badge warn',
        text: 'Fragile',
        title:
          'A generated selector: breaks when the markup changes. Copy a data-fx attribute into the markup.'
      }),
      copy
    )
  }

  // Palette.

  private openPalette(): void {
    this.menu.hidden = true
    this.pal.hidden = false
    this.palInput.value = ''
    this.palIndex = 0
    this.renderPalette()
    this.palInput.focus()
  }

  private closePalette(): void {
    this.pal.hidden = true
    if (this.sel === null) {
      this.hoverBox.hidden = true
    }
  }

  private items(): PalItem[] {
    const out: PalItem[] = []
    const insts = this.s.instances()
    for (const i of insts) {
      if (i.el === null) {
        out.push({
          group: 'page',
          label: i.id,
          chips: [i.effect, i.handle.enabled ? 'on' : 'off'],
          run: () => this.select({ page: i.id })
        })
      }
    }
    const rows = new Map<Element, string[]>()
    for (const i of insts) {
      if (i.el) {
        rows.set(i.el, [...(rows.get(i.el) ?? []), i.id])
      }
    }
    for (const i of this.s.inspected()) {
      rows.set(i.el, [...(rows.get(i.el) ?? []), ...i.kinds])
    }
    for (const [el, chips] of rows) {
      out.push({
        group: 'element',
        label: labelOf(el, 60),
        chips,
        el,
        run: () => {
          this.select({ el })
          const r = el.getBoundingClientRect()
          if (r.bottom < 0 || r.top > window.innerHeight) {
            el.scrollIntoView({ block: 'center' })
          }
        }
      })
    }
    if (this.s.live()) {
      for (const d of this.s.effectDefs('page')) {
        out.push({
          group: 'add',
          label: d.label,
          run: () => {
            const id = this.s.add(d, null)
            if (id) {
              this.openCards.add(id)
              this.select({ page: id })
            }
          }
        })
      }
    } else if (this.s.mods) {
      out.push({
        group: 'action',
        label: 'Start a config',
        run: () => this.s.startConfig()
      })
    }
    const act = (label: string, run: () => void): void => {
      out.push({ group: 'action', label, run })
    }
    act('Save', () => void this.s.save())
    if (this.s.store.supported) {
      act('Save as…', () => void this.s.saveAs())
    }
    act(
      this.s.store.supported ? 'Open…' : 'Upload…',
      () => void this.s.openFile()
    )
    act('Undo', () => this.s.undo())
    act('Redo', () => this.s.redo())
    act(this.preview ? 'Select mode' : 'Preview mode', () =>
      this.setPreview(!this.preview)
    )
    act('Close the editor', () => this.close())
    return out
  }

  private renderPalette(): void {
    const words = this.palInput.value.toLowerCase().split(/\s+/).filter(Boolean)
    this.palItems = this.items().filter((it) => {
      const text =
        `${it.group} ${it.label} ${(it.chips ?? []).join(' ')}`.toLowerCase()
      return words.every((w) => text.includes(w))
    })
    this.palIndex = Math.min(
      this.palIndex,
      Math.max(0, this.palItems.length - 1)
    )
    const heads: Record<string, string> = {
      page: 'Page effects',
      element: 'Elements',
      add: 'Add to the page',
      action: 'Actions'
    }
    const icons: Record<string, Parameters<typeof icon>[0]> = {
      page: 'layers',
      element: 'pointer',
      add: 'plus',
      action: 'chevronRight'
    }
    const rows: HTMLElement[] = []
    let group = ''
    this.palItems.forEach((it, n) => {
      if (it.group !== group) {
        group = it.group
        rows.push(
          h('li', {
            class: 'ghead',
            role: 'presentation',
            text: heads[group] ?? group
          })
        )
      }
      const li = h(
        'li',
        {
          role: 'option',
          'data-n': n,
          'aria-selected': n === this.palIndex
        },
        icon(icons[it.group] ?? 'chevronRight', 14),
        h('span', { class: 'lbl', text: it.label }),
        h(
          'span',
          { class: 'chips' },
          ...(it.chips ?? []).map((c) => h('span', { class: 'badge', text: c }))
        )
      )
      li.addEventListener('click', () => this.runItem(n))
      li.addEventListener('mousemove', () => {
        if (this.palIndex !== n) {
          this.palIndex = n
          this.markPalette()
        }
      })
      rows.push(li)
    })
    if (!rows.length) {
      rows.push(h('li', { class: 'none', text: 'Nothing matches.' }))
    }
    this.palList.replaceChildren(...rows)
    this.markPalette()
  }

  private markPalette(): void {
    for (const li of this.palList.querySelectorAll('li[role="option"]')) {
      const on = Number(li.getAttribute('data-n')) === this.palIndex
      li.setAttribute('aria-selected', String(on))
      if (on) {
        li.scrollIntoView({ block: 'nearest' })
      }
    }
    const el = this.palItems[this.palIndex]?.el ?? null
    if (el) {
      this.place(this.hoverBox, el, labelOf(el))
    } else {
      this.hoverBox.hidden = true
    }
  }

  private paletteKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      this.closePalette()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = this.palItems.length
      if (n) {
        this.palIndex =
          (this.palIndex + (e.key === 'ArrowDown' ? 1 : -1) + n) % n
        this.markPalette()
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      this.runItem(this.palIndex)
    }
  }

  private runItem(n: number): void {
    const it = this.palItems[n]
    this.closePalette()
    it?.run()
  }
}
