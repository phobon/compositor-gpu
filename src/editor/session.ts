import type { ConfigInstance, FxConfig, LiveConfig, Match } from '../fx/config'
import type { EffectDef } from '../fx/registry'
import type { InspectedElement } from '../gpu/graph'
import type { Compositor } from '../types'
import { addEffect, History, uniqueId } from './edits'
import { describeDiff, diffConfigs } from './file'
import { selectorFor, suggestName } from './pick'
import { download, FileStore, upload } from './store'

// What the editor (docs/EDITOR.md) works on, apart from its UI: the
// page's config, its edits and undo, the file it saves to, and what the
// scene composites. /fx's config, registry and runtime are loaded by
// load(), so mounting the editor doesn't bundle the effects until then.

export interface Mods {
  config: typeof import('../fx/config')
  registry: typeof import('../fx/registry')
  effects: typeof import('../fx/effects')
}

/** A question for the person (an unsaved draft, a file that differs). */
export interface Banner {
  text: string
  actions: Record<string, () => void>
}

/** Autosave after the last change, ms. */
const AUTOSAVE_MS = 300
const AUTOSAVE_KEY = 'compositor-gpu:edit-autosave'

export const countOf = (sel: string): number => {
  try {
    return document.querySelectorAll(sel).length
  } catch {
    return 0
  }
}

export class EditSession {
  mods: Mods | null = null
  readonly history = new History()
  readonly store = new FileStore()
  dirty = false
  liveIndex = 0
  private loading: Promise<Mods> | null = null
  private restored: Promise<void> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private readonly listeners = new Set<() => void>()
  /** Set by the UI. */
  status: (s: string) => void = () => {}
  banner: (b: Banner | null) => void = () => {}

  constructor(readonly compositor: Compositor) {}

  /** Load /fx (once), then bring back the remembered file and any
   * draft. */
  load(): Promise<Mods> {
    this.loading ??= Promise.all([
      import('../fx/config'),
      import('../fx/registry'),
      import('../fx/effects')
    ]).then(([config, registry, effects]) => {
      this.mods = { config, registry, effects }
      this.restored ??= this.restore()
      this.emit()
      return this.mods
    })
    return this.loading
  }

  /** Called after every change the UI should show. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit(): void {
    for (const fn of this.listeners) {
      fn()
    }
  }

  // What the page has.

  lives(): LiveConfig[] {
    return this.mods?.config.liveConfigs() ?? []
  }

  live(): LiveConfig | null {
    const ls = this.lives()
    return ls[Math.min(this.liveIndex, ls.length - 1)] ?? null
  }

  instances(): ConfigInstance[] {
    return this.live()?.instances() ?? []
  }

  inspected(): InspectedElement[] {
    try {
      return this.compositor.graph?.inspect() ?? []
    } catch {
      return []
    }
  }

  /** Elements with a config effect or composited by the scene. */
  known(): Set<Element> {
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

  effectDefs(scope: 'page' | 'element'): EffectDef[] {
    return (this.mods?.registry.listEffects() ?? []).filter((d) =>
      d.scopes.includes(scope)
    )
  }

  // Editing.

  commit(next: FxConfig, coalesce?: string): void {
    const live = this.live()
    if (!live) {
      return
    }
    this.history.push(live.config, coalesce, performance.now())
    live.update(next)
    this.changed()
  }

  undo(): void {
    const live = this.live()
    const prev = live && this.history.undo(live.config)
    if (live && prev) {
      live.update(prev)
      this.changed()
    }
  }

  redo(): void {
    const live = this.live()
    const next = live && this.history.redo(live.config)
    if (live && next) {
      live.update(next)
      this.changed()
    }
  }

  matchFor(el: Element): Match {
    const fx = el.getAttribute('data-fx')
    return fx ? { fx } : { selector: selectorFor(el, countOf) }
  }

  /** Add effect `def` to `el` (null: the page); returns its id. */
  add(def: EffectDef, el: Element | null): string | null {
    const live = this.live()
    if (!live) {
      return null
    }
    const id = uniqueId(
      live.config,
      el ? `${suggestName(el)}-${def.id}` : def.id
    )
    this.commit(
      addEffect(live.config, el ? this.matchFor(el) : null, def.id, id)
    )
    return id
  }

  /** Apply an empty config on a page that has none. */
  startConfig(): void {
    const m = this.mods
    if (!m) {
      return
    }
    m.config.applyConfig(m.effects.createEffects(this.compositor), {
      version: 1
    })
    this.liveIndex = m.config.liveConfigs().length - 1
    this.emit()
  }

  // Saving.

  get autosave(): boolean {
    try {
      return localStorage.getItem(AUTOSAVE_KEY) !== '0'
    } catch {
      return true
    }
  }

  set autosave(on: boolean) {
    try {
      localStorage.setItem(AUTOSAVE_KEY, on ? '1' : '0')
    } catch {
      // Storage blocked.
    }
    if (on && this.dirty) {
      this.scheduleSave()
    }
    this.emit()
  }

  /** After every change: a draft, then the file (autosave). */
  private changed(): void {
    const live = this.live()
    this.dirty = true
    if (live) {
      this.store.saveDraft(live.config)
    }
    if (this.autosave && this.store.state === 'ready') {
      this.scheduleSave()
    }
    this.emit()
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
    this.emit()
    return ok
  }

  async save(): Promise<void> {
    const live = this.live()
    if (!live) {
      return
    }
    clearTimeout(this.saveTimer)
    if (!this.store.supported) {
      download(live.config)
      this.dirty = false
      this.store.clearDraft()
      this.emit()
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
      this.emit()
      return
    }
    if (await this.write()) {
      this.status(`Saved ${this.store.name}.`)
    }
  }

  async saveAs(): Promise<void> {
    const live = this.live()
    if (live && (await this.store.saveAs(live.config))) {
      this.dirty = false
      this.banner(null)
      this.status(`Saved ${this.store.name}.`)
    }
    this.emit()
  }

  async openFile(): Promise<void> {
    try {
      const c = this.store.supported ? await this.store.open() : await upload()
      if (c) {
        this.offerFile(c, this.store.name ?? 'The file')
      }
    } catch (e) {
      this.status(`Not a config: ${(e as Error).message}`)
    }
    this.emit()
  }

  /** Write access again after a reload (the file chip). */
  async allow(): Promise<void> {
    if (this.store.state !== 'needs-permission') {
      return
    }
    if (await this.store.grant()) {
      await this.compareFile()
    }
    this.emit()
  }

  /** Write a pending change now (the editor closing). */
  flush(): void {
    clearTimeout(this.saveTimer)
    if (this.dirty && this.store.state === 'ready') {
      void this.write()
    }
  }

  private async restore(): Promise<void> {
    await this.store.restore()
    const live = this.live()
    const d = this.store.draft()
    if (live && d) {
      const diff = describeDiff(diffConfigs(live.config, d.config))
      if (diff) {
        const at = new Date(d.at).toLocaleTimeString()
        this.banner({
          text: `Unsaved edits from ${at} (${diff}).`,
          actions: {
            Restore: () => this.commit(d.config),
            Discard: () => this.store.clearDraft()
          }
        })
      } else {
        this.store.clearDraft()
      }
    }
    if (this.store.state === 'ready' && !d) {
      await this.compareFile()
    }
    this.emit()
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
      this.banner(null)
      return
    }
    this.banner({
      text: `${name} differs from the page (${diff}).`,
      actions: {
        'Use the file': () => {
          this.commit(c)
          this.dirty = false
          this.store.clearDraft()
          this.emit()
        },
        'Keep the page': () => {
          this.dirty = true
          if (this.autosave && this.store.state === 'ready') {
            this.scheduleSave()
          }
          this.emit()
        }
      }
    })
  }

  /** The file chip's text and title. */
  fileLabel(): { text: string; title: string } {
    const st = this.store.state
    const name = this.store.name ?? ''
    return {
      text:
        st === 'none'
          ? this.dirty
            ? 'No file · unsaved'
            : 'No file'
          : st === 'needs-permission'
            ? `${name} · click to allow writing`
            : `${name} · ${this.dirty ? 'unsaved' : 'saved'}`,
      title:
        st === 'needs-permission'
          ? 'The browser asks again after a reload'
          : st === 'ready'
            ? 'The file the edits are written to'
            : 'Save to choose a file'
    }
  }
}
