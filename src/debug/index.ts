// `compositor-gpu/debug`: a corner button that opens a panel of debug
// toggles for one compositor.
//
//   stats     the profiler HUD (compositor.profile.hud)
//   dials     the DialKit panels (compositor-gpu/dials, setDialsShown)
//   skeleton  geometry drawn as wireframe (compositor.skeleton)
//
// Each flag starts from localStorage (`storageKey`), overridden by the
// page URL (`?stats=1`, `?dials=0`, a bare `?skeleton` is on); a toggle
// applies at once and stores every flag. The panel sits in a shadow root
// on <html> marked data-gpu-ignore, outside the mirrored root.

import { dialsShown, setDialsShown } from '../dials'
import { SKELETON_COLORS } from '../gpu/skeleton'
import type { Compositor } from '../types'

export type DebugFlag = 'stats' | 'dials' | 'skeleton'

export interface DebugPanelOptions {
  /** Corner of the viewport. Default 'bottom-right' (the HUD is
   * bottom-left, the dials top-right). */
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
  /** localStorage key for the flags. Default 'compositor-gpu:debug'. */
  storageKey?: string
}

export interface DebugPanel {
  get(flag: DebugFlag): boolean
  set(flag: DebugFlag, on: boolean): void
  /** Remove the panel; the flags stay as they are. */
  destroy(): void
}

const FLAGS: readonly { flag: DebugFlag; label: string; hint: string }[] = [
  { flag: 'stats', label: 'Stats', hint: 'Frame HUD' },
  { flag: 'dials', label: 'Dials', hint: 'Effect params' },
  { flag: 'skeleton', label: 'Skeleton', hint: 'Wireframe meshes' }
]

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  position: fixed; z-index: 2147483647; display: flex; gap: 6px;
  font: 12px/1.3 ui-sans-serif, system-ui, sans-serif; color: #e5e7eb;
}
.v-top { top: 12px; flex-direction: column; }
.v-bottom { bottom: 12px; flex-direction: column-reverse; }
.h-left { left: 12px; align-items: flex-start; }
.h-right { right: 12px; align-items: flex-end; }
button.fab {
  appearance: none; border: 1px solid rgba(255,255,255,0.14);
  background: rgba(17,17,20,0.88); color: inherit; font: inherit;
  font-weight: 600; letter-spacing: 0.04em; height: 28px; padding: 0 10px;
  border-radius: 14px; cursor: pointer; display: flex; align-items: center;
  gap: 6px; backdrop-filter: blur(8px);
}
button.fab:hover { background: rgba(38,38,44,0.92); }
button.fab:focus-visible, label:focus-within {
  outline: 2px solid #38bdf8; outline-offset: 2px;
}
.dot { width: 6px; height: 6px; border-radius: 3px; background: #4b5563; }
.dot.on { background: #34d399; }
.panel {
  width: 200px; padding: 6px; border-radius: 10px;
  background: rgba(17,17,20,0.92); border: 1px solid rgba(255,255,255,0.12);
  box-shadow: 0 8px 24px rgba(0,0,0,0.35); backdrop-filter: blur(8px);
}
.panel[hidden] { display: none; }
label {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer;
}
label:hover { background: rgba(255,255,255,0.06); }
label.off { opacity: 0.45; cursor: default; }
.hint { color: #9ca3af; font-size: 11px; }
input {
  appearance: none; margin: 0; width: 28px; height: 16px; flex: none;
  border-radius: 8px; background: #374151; position: relative;
  cursor: inherit; transition: background 120ms;
}
input::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 12px;
  height: 12px; border-radius: 6px; background: #e5e7eb;
  transition: transform 120ms;
}
input:checked { background: #0ea5e9; }
input:checked::after { transform: translateX(12px); }
input:focus-visible { outline: none; }
.legend {
  display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 4px 8px 6px;
  color: #9ca3af; font-size: 11px;
}
.legend[hidden] { display: none; }
.legend span { display: flex; align-items: center; gap: 4px; }
.legend i { width: 8px; height: 8px; border: 1.5px solid; border-radius: 2px; }
.note { padding: 4px 8px 6px; color: #f87171; font-size: 11px; }
@media (prefers-reduced-motion: reduce) {
  input, input::after { transition: none; }
}
`

function readStored(key: string): Partial<Record<DebugFlag, boolean>> {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) ?? '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

function readUrl(flag: DebugFlag): boolean | undefined {
  const q = new URLSearchParams(window.location.search)
  if (!q.has(flag)) {
    return undefined
  }
  const v = q.get(flag)
  return v !== '0' && v !== 'false'
}

/** Mount the panel for `compositor`; inert (a no-op panel) on the
 * server. */
export function mountDebugPanel(
  compositor: Compositor,
  opts: DebugPanelOptions = {}
): DebugPanel {
  const flags: Record<DebugFlag, boolean> = {
    stats: false,
    dials: false,
    skeleton: false
  }
  if (typeof window === 'undefined') {
    return {
      get: (f) => flags[f],
      set: () => {},
      destroy: () => {}
    }
  }
  const key = opts.storageKey ?? 'compositor-gpu:debug'
  const stored = readStored(key)
  for (const { flag } of FLAGS) {
    flags[flag] =
      readUrl(flag) ?? stored[flag] ?? (flag === 'dials' && dialsShown())
  }

  const gpu = compositor.active
  const apply = (flag: DebugFlag): void => {
    const on = flags[flag]
    if (flag === 'stats') {
      if (gpu) {
        compositor.profile.hud(on)
      }
    } else if (flag === 'dials') {
      setDialsShown(on)
    } else if (gpu) {
      compositor.skeleton = on
    }
  }

  const host = document.createElement('div')
  host.setAttribute('data-gpu-ignore', '')
  host.setAttribute('data-compositor-debug', '')
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CSS
  const [v, h] = (opts.position ?? 'bottom-right').split('-') as [
    string,
    string
  ]
  const root = document.createElement('div')
  root.className = `root v-${v} h-${h}`

  const fab = document.createElement('button')
  fab.className = 'fab'
  fab.type = 'button'
  fab.setAttribute('aria-expanded', 'false')
  fab.setAttribute('aria-controls', 'panel')
  const dot = document.createElement('span')
  dot.className = 'dot'
  fab.append(dot, 'GPU')
  fab.title = 'compositor-gpu debug'

  const panel = document.createElement('div')
  panel.className = 'panel'
  panel.id = 'panel'
  panel.hidden = true
  panel.setAttribute('role', 'group')
  panel.setAttribute('aria-label', 'compositor-gpu debug')

  const inputs = new Map<DebugFlag, HTMLInputElement>()
  for (const { flag, label, hint } of FLAGS) {
    const row = document.createElement('label')
    const text = document.createElement('span')
    const name = document.createElement('div')
    name.textContent = label
    const sub = document.createElement('div')
    sub.className = 'hint'
    sub.textContent = hint
    text.append(name, sub)
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('role', 'switch')
    input.checked = flags[flag]
    const usable = gpu || flag === 'dials'
    input.disabled = !usable
    if (!usable) {
      row.className = 'off'
    }
    input.addEventListener('change', () => set(flag, input.checked))
    row.append(text, input)
    panel.append(row)
    inputs.set(flag, input)
  }
  const legend = document.createElement('div')
  legend.className = 'legend'
  for (const [name, color] of Object.entries(SKELETON_COLORS)) {
    const s = document.createElement('span')
    const swatch = document.createElement('i')
    swatch.style.borderColor = color
    s.append(swatch, name)
    legend.append(s)
  }
  panel.append(legend)
  if (!gpu) {
    const note = document.createElement('div')
    note.className = 'note'
    note.textContent = 'No WebGPU: compositor inactive'
    panel.append(note)
  }

  root.append(fab, panel)
  shadow.append(style, root)
  document.documentElement.append(host)

  const sync = (): void => {
    for (const [flag, input] of inputs) {
      input.checked = flags[flag]
    }
    legend.hidden = !(flags.skeleton && gpu)
    dot.classList.toggle(
      'on',
      FLAGS.some(({ flag }) => flags[flag])
    )
  }
  const open = (on: boolean): void => {
    panel.hidden = !on
    fab.setAttribute('aria-expanded', String(on))
  }
  const set = (flag: DebugFlag, on: boolean): void => {
    flags[flag] = on
    apply(flag)
    sync()
    try {
      window.localStorage.setItem(key, JSON.stringify(flags))
    } catch {
      // Storage blocked: the flags last for this page only.
    }
  }

  fab.addEventListener('click', () => open(panel.hidden !== false))
  const onDown = (e: PointerEvent): void => {
    if (!panel.hidden && !e.composedPath().includes(host)) {
      open(false)
    }
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !panel.hidden) {
      open(false)
      fab.focus()
    }
  }
  document.addEventListener('pointerdown', onDown, true)
  document.addEventListener('keydown', onKey)

  for (const { flag } of FLAGS) {
    apply(flag)
  }
  sync()

  return {
    get: (flag) => flags[flag],
    set,
    destroy() {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
      host.remove()
    }
  }
}
