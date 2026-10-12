// `compositor-gpu/dials`: live tuning panels built from effect schemas,
// with DialKit (an optional peer dependency, loaded on first use).
// Nothing happens unless the page URL has `?dials=1` (configureDials
// changes the parameter).
//
// attachDials(panel, folder, entry) adds `entry.schema` as a folder of
// the floating panel `panel` (folder null: at the panel's top level).
// Defs follow the effects' ParamSchema: `f32` / `i32` / `u32` are
// sliders (`step` optional), `vec2`..`vec4` one slider per component
// (`path.0`, ...), `color` a colour picker, and two more types for page
// timing: `{ type: 'easing', default: { duration, ease } }` and
// `{ type: 'spring', default: { visualDuration, bounce } }` (or
// stiffness/damping/mass). Paths are dotted (`from.scale`). On every
// change the values are written to each of `entry.targets` at the same
// paths, then `entry.onChange` gets them by path. Every entry attached
// to one panel and folder shares its controls. Values persist per panel
// in localStorage (`dialkit:fx-<panel>`).
//
// The panels sit in one root marked data-gpu-ignore. 'inline' (the
// default) puts them, always open, in a fixed host on <html>, outside a
// compositor root on <body> and above its canvas; 'popover' is DialKit's
// floating root behind a toggle.

type Bezier = [number, number, number, number]

export interface DialDef {
  readonly type: string
  readonly default?: unknown
  readonly min?: number
  readonly max?: number
  readonly step?: number
}

export type DialSchema = Readonly<Record<string, DialDef>>

export interface DialEntry {
  schema: DialSchema
  /** Written at the schema's paths on every change (effect params, a
   * hook's timing object). */
  targets?: readonly object[]
  /** The values by schema path, on every change, after `targets`. */
  onChange?: (values: Record<string, unknown>) => void
  /** Buttons, label → callback. */
  actions?: Record<string, () => void>
}

export interface PanelOptions {
  /** Start the panel collapsed (the first attach decides). */
  collapsed?: boolean
}

export interface DialsConfig {
  /** Query parameter that turns the panels on (`?<param>=1`). Default
   * 'dials'. */
  param?: string
  /** Default 'top-right'. */
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
  /** Default 'system'. */
  theme?: 'light' | 'dark' | 'system'
  /** Default 'inline'. */
  mode?: 'inline' | 'popover'
}

type DialKit = typeof import('./load')
type Kit = ReturnType<DialKit['createDialKit']>
type Values = Record<string, unknown>

interface Folder {
  schema: DialSchema
  entries: Set<DialEntry>
}

interface Panel {
  folders: Map<string | null, Folder>
  kit: Kit | null
  timer: ReturnType<typeof setTimeout> | undefined
  users: number
  collapsed: boolean
  actions: Map<string, Array<() => void>>
}

const config: Required<DialsConfig> = {
  param: 'dials',
  position: 'top-right',
  theme: 'system',
  mode: 'inline'
}
const panels = new Map<string, Panel>()
let root: { destroy(): void } | null = null

export function configureDials(c: DialsConfig): void {
  Object.assign(config, c)
}

/** True when the URL asks for the panels. */
export function dialsWanted(): boolean {
  return (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get(config.param) === '1'
  )
}

/** Add `entry` to `panel` (in `folder`); returns the detach. */
export function attachDials(
  panel: string,
  folder: string | null,
  entry: DialEntry,
  opts: PanelOptions = {}
): () => void {
  if (!dialsWanted()) {
    return () => {}
  }
  let p = panels.get(panel)
  if (!p) {
    p = {
      folders: new Map(),
      kit: null,
      timer: undefined,
      users: 0,
      collapsed: opts.collapsed ?? false,
      actions: new Map()
    }
    panels.set(panel, p)
  }
  const pp = p
  pp.users++
  let f = pp.folders.get(folder)
  if (!f) {
    f = { schema: entry.schema, entries: new Set() }
    pp.folders.set(folder, f)
  }
  const ff = f
  ff.entries.add(entry)
  // Folders attach as effects mount: (re)build once they settle.
  schedule(panel, pp)
  return () => {
    ff.entries.delete(entry)
    if (ff.entries.size === 0) {
      pp.folders.delete(folder)
    }
    if (--pp.users === 0) {
      clearTimeout(pp.timer)
      pp.kit?.destroy()
      panels.delete(panel)
      if (panels.size === 0) {
        root?.destroy()
        root = null
      }
    } else {
      schedule(panel, pp)
    }
  }
}

function schedule(panel: string, p: Panel): void {
  clearTimeout(p.timer)
  p.timer = setTimeout(() => build(panel, p), 50)
}

function build(panel: string, p: Panel): void {
  import('./load')
    .then((dk) => {
      if (panels.get(panel) !== p) {
        return
      }
      root ??= mountRoot(dk)
      const cfg: Values = {}
      p.actions.clear()
      for (const [folder, f] of p.folders) {
        const c: Values = folder === null ? cfg : {}
        for (const [path, def] of Object.entries(f.schema)) {
          for (const [key, ctl] of controls(path, def)) {
            setPath(c, key, ctl)
          }
        }
        for (const e of f.entries) {
          for (const [label, fn] of Object.entries(e.actions ?? {})) {
            const key = label.toLowerCase().replace(/\W+/g, '_')
            c[key] = { type: 'action', label }
            const at = folder === null ? key : `${folder}.${key}`
            const fns = p.actions.get(at) ?? []
            fns.push(fn)
            p.actions.set(at, fns)
          }
        }
        if (folder !== null) {
          cfg[folder] = c
        }
      }
      const kitConfig = cfg as Parameters<DialKit['createDialKit']>[1]
      if (p.kit) {
        p.kit.updateConfig(kitConfig)
        return
      }
      const kit = dk.createDialKit(panel, kitConfig, {
        id: `fx-${panel}`,
        persist: true,
        defaultCollapsed: p.collapsed,
        onAction: (path) => {
          for (const fn of p.actions.get(path) ?? []) {
            fn()
          }
        }
      })
      p.kit = kit
      kit.subscribe((values) => apply(p, values as Values))
    })
    .catch((err: unknown) => {
      console.warn('[dials] DialKit failed to load:', err)
    })
}

function apply(p: Panel, values: Values): void {
  for (const [folder, f] of p.folders) {
    const v = folder === null ? values : getPath(values, folder)
    if (!v || typeof v !== 'object') {
      continue
    }
    const out: Values = {}
    for (const [path, def] of Object.entries(f.schema)) {
      const val = read(v as Values, path, def)
      if (val !== undefined) {
        out[path] = val
      }
    }
    for (const e of f.entries) {
      for (const t of e.targets ?? []) {
        for (const [path, val] of Object.entries(out)) {
          setPath(t as Values, path, val)
        }
      }
      e.onChange?.(out)
    }
  }
}

function mountRoot(dk: DialKit): { destroy(): void } {
  if (config.mode === 'popover') {
    const r = dk.createDialRoot({
      position: config.position,
      theme: config.theme
    })
    r.element.setAttribute('data-gpu-ignore', '')
    return r
  }
  const host = document.createElement('div')
  const [v, h] = config.position.split('-') as [string, string]
  Object.assign(host.style, {
    position: 'fixed',
    [v]: '12px',
    [h]: '12px',
    width: '300px',
    maxHeight: 'calc(100dvh - 24px)',
    overflow: 'auto',
    zIndex: '2147483647'
  })
  host.setAttribute('data-gpu-ignore', '')
  document.documentElement.append(host)
  const r = dk.createDialRoot({
    mode: 'inline',
    target: host,
    theme: config.theme
  })
  return {
    destroy() {
      r.destroy()
      host.remove()
    }
  }
}

function step(def: DialDef, min: number, max: number): number {
  if (def.step !== undefined) {
    return def.step
  }
  if (def.type === 'i32' || def.type === 'u32') {
    return 1
  }
  const span = max - min
  return span <= 2 ? 0.01 : span <= 20 ? 0.1 : 1
}

/** DialKit controls for one schema entry: [configPath, control]. */
function controls(path: string, def: DialDef): [string, unknown][] {
  const min = def.min ?? 0
  const max = def.max ?? 1
  switch (def.type) {
    case 'easing':
      return [[path, { type: 'easing', ...(def.default as object) }]]
    case 'spring':
      return [[path, { ...(def.default as object), type: 'spring' }]]
    case 'color':
      return typeof def.default === 'string'
        ? [[path, { type: 'color', default: def.default }]]
        : []
    case 'f32':
    case 'i32':
    case 'u32':
      return [[path, [def.default ?? min, min, max, step(def, min, max)]]]
    case 'vec2':
    case 'vec3':
    case 'vec4':
      return ((def.default as readonly number[] | undefined) ?? []).map(
        (d, i) => [`${path}.${i}`, [d, min, max, step(def, min, max)]]
      )
    default:
      return []
  }
}

/** The value for `path` from DialKit's resolved values. */
function read(values: Values, path: string, def: DialDef): unknown {
  const at = getPath(values, path)
  if (at === undefined || at === null) {
    return undefined
  }
  if (def.type === 'easing') {
    const e = at as { duration: number; ease: Bezier }
    return { duration: e.duration, ease: e.ease }
  }
  if (def.type.startsWith('vec')) {
    if (typeof at !== 'object') {
      return undefined
    }
    const d = (def.default as readonly number[] | undefined) ?? []
    return d.map((x, i) => (at as Values)[i] ?? x)
  }
  return at
}

function getPath(o: unknown, path: string): unknown {
  let cur = o
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') {
      return undefined
    }
    cur = (cur as Values)[k]
  }
  return cur
}

function setPath(o: Values, path: string, v: unknown): void {
  const keys = path.split('.')
  const last = keys.pop() as string
  let cur = o
  for (const k of keys) {
    if (cur[k] === null || typeof cur[k] !== 'object') {
      cur[k] = {}
    }
    cur = cur[k] as Values
  }
  cur[last] = v
}
