import type { FxConfig } from '../fx/config'
import { parseConfig, serialize } from './file'

// Where the editor saves (docs/EDITOR.md, E4): a file picked with the
// File System Access API, its handle kept in IndexedDB per page path so
// a reload needs one click to write again, and a draft in localStorage
// until a write succeeds. Without the API (Safari, Firefox) files go
// through a download and an upload.

interface PermissionHandle extends FileSystemFileHandle {
  queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>
}

interface PickerWindow {
  showOpenFilePicker?(o: object): Promise<PermissionHandle[]>
  showSaveFilePicker?(o: object): Promise<PermissionHandle>
}

const TYPES = [
  {
    description: 'compositor-gpu config',
    accept: { 'application/json': ['.json'] }
  }
]

const DB = 'compositor-gpu'
const STORE = 'edit-handles'

function idb<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest
): Promise<T | undefined> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(undefined)
      return
    }
    const open = indexedDB.open(DB, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(STORE)
    open.onerror = () => resolve(undefined)
    open.onsuccess = () => {
      try {
        const tx = open.result.transaction(STORE, mode)
        const req = run(tx.objectStore(STORE))
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => resolve(undefined)
        tx.oncomplete = () => open.result.close()
      } catch {
        resolve(undefined)
      }
    }
  })
}

export type StoreState = 'none' | 'needs-permission' | 'ready'

interface Draft {
  config: FxConfig
  at: number
}

export class FileStore {
  private handle: PermissionHandle | null = null
  private granted = false
  private readonly key: string

  constructor(
    /** Scopes the remembered file and the draft (default: the path). */
    scope = typeof location === 'undefined' ? '' : location.pathname
  ) {
    this.key = `edit:${scope}`
  }

  /** The File System Access API is there (Chromium). */
  get supported(): boolean {
    const w = globalThis as PickerWindow
    return !!w.showOpenFilePicker && !!w.showSaveFilePicker
  }

  get name(): string | null {
    return this.handle?.name ?? null
  }

  get state(): StoreState {
    return !this.handle ? 'none' : this.granted ? 'ready' : 'needs-permission'
  }

  /** Bring back the file this page used before (permission may still
   * need a click: grant()). */
  async restore(): Promise<void> {
    if (!this.supported) {
      return
    }
    const h = await idb<PermissionHandle>('readonly', (s) => s.get(this.key))
    if (h) {
      this.handle = h
      this.granted =
        (await h.queryPermission?.({ mode: 'readwrite' })) === 'granted'
    }
  }

  /** Ask for write access again (needs a user gesture). */
  async grant(): Promise<boolean> {
    const h = this.handle
    if (!h) {
      return false
    }
    this.granted =
      (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted'
    return this.granted
  }

  /** Pick a file and read it. Null when cancelled. */
  async open(): Promise<FxConfig | null> {
    const w = globalThis as PickerWindow
    let hs: PermissionHandle[]
    try {
      hs = (await w.showOpenFilePicker?.({ types: TYPES })) ?? []
    } catch {
      return null
    }
    const h = hs[0]
    if (!h) {
      return null
    }
    const c = parseConfig(await (await h.getFile()).text())
    await this.use(h)
    return c
  }

  /** Read the current file again. */
  async read(): Promise<FxConfig | null> {
    if (!this.handle) {
      return null
    }
    return parseConfig(await (await this.handle.getFile()).text())
  }

  /** Pick where to write `c`, and write it. False when cancelled. */
  async saveAs(c: FxConfig): Promise<boolean> {
    const w = globalThis as PickerWindow
    let h: PermissionHandle | undefined
    try {
      h = await w.showSaveFilePicker?.({
        types: TYPES,
        suggestedName: this.name ?? 'fx.config.json'
      })
    } catch {
      return false
    }
    if (!h) {
      return false
    }
    await this.use(h)
    return this.write(c)
  }

  /** Write `c` to the current file; false without one or access. */
  async write(c: FxConfig): Promise<boolean> {
    const h = this.handle
    if (!h || !this.granted) {
      return false
    }
    try {
      const out = await h.createWritable()
      await out.write(serialize(c))
      await out.close()
      this.clearDraft()
      return true
    } catch {
      return false
    }
  }

  /** Stop using the file (the page forgets it too). */
  async forget(): Promise<void> {
    this.handle = null
    this.granted = false
    await idb('readwrite', (s) => s.delete(this.key))
  }

  private async use(h: PermissionHandle): Promise<void> {
    this.handle = h
    this.granted =
      (await h.queryPermission?.({ mode: 'readwrite' })) === 'granted' ||
      (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted'
    await idb('readwrite', (s) => s.put(h, this.key))
  }

  // Drafts: what the editor changed and no file write has kept yet.

  saveDraft(c: FxConfig): void {
    try {
      localStorage.setItem(
        `compositor-gpu:${this.key}:draft`,
        JSON.stringify({ config: c, at: Date.now() } satisfies Draft)
      )
    } catch {
      // Storage blocked: no draft.
    }
  }

  draft(): Draft | null {
    try {
      const s = localStorage.getItem(`compositor-gpu:${this.key}:draft`)
      if (!s) {
        return null
      }
      const d = JSON.parse(s) as Draft
      return { config: parseConfig(JSON.stringify(d.config)), at: d.at }
    } catch {
      return null
    }
  }

  clearDraft(): void {
    try {
      localStorage.removeItem(`compositor-gpu:${this.key}:draft`)
    } catch {
      // Storage blocked.
    }
  }
}

/** Download `c` as a file (no File System Access). */
export function download(c: FxConfig, name = 'fx.config.json'): void {
  const url = URL.createObjectURL(
    new Blob([serialize(c)], { type: 'application/json' })
  )
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Read a config from a file the person chooses (no File System
 * Access). Null when cancelled. */
export function upload(): Promise<FxConfig | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.addEventListener('change', () => {
      const f = input.files?.[0]
      if (!f) {
        resolve(null)
        return
      }
      f.text().then((t) => {
        try {
          resolve(parseConfig(t))
        } catch (e) {
          reject(e)
        }
      }, reject)
    })
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}
