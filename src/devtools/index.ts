// `compositor-gpu/devtools` (docs/PROFILER.md, M6b): one panel for
// profiling and debugging a compositor on any site.
//
//   Live      the most recent frames as they happen
//   Timeline  a recording's frames, compositor and GPU work and the page's
//             long animation frames over time, the selected frame below
//             it: why it came late (hitch factors) and what it did
//   Elements  cost by element, GPU pass and what kept the loop running
//   Settings  the flight recorder, Chrome DevTools tracks, the frame HUD,
//             dials, skeleton, scene reuse, where the panel docks
//
// While mounted, the flight recorder keeps the last seconds (15 by
// default): after a jank, Save (or Alt+Shift+S) turns them into a
// recording and opens it at its worst frame. Record / Stop take an
// explicit one; Import and Export read and write `.cgprof` files (also
// by dropping a file on the panel). Recordings from this page point at
// live elements (hover a chip to outline one, click to scroll to it).
//
// The panel sits in a shadow root on <html> marked data-gpu-ignore,
// outside the mirrored root. Its settings persist in localStorage
// (`storageKey`) and the URL seeds them: `?devtools` opens it,
// `?stats=1`, `?dials=1`, `?skeleton=1` as compositor-gpu/debug, and
// `?tracks=1` the DevTools tracks.

import { dialsShown, setDialsShown } from '../dials'
import { SKELETON_COLORS } from '../gpu/skeleton'
import { estimateRefresh, missed } from '../profile/profiler'
import {
  decodeRecording,
  encodeRecording,
  type Recording,
  recordingFileName,
  toRecording
} from '../profile/recording'
import type { Compositor } from '../types'
import { CSS } from './css'
import { renderElements } from './elements_view'
import { type FrameActions, renderFrame } from './frame_view'
import { LiveView } from './live_view'
import { h, Model } from './model'
import { Timeline } from './timeline'

export type DevtoolsTab = 'live' | 'timeline' | 'elements' | 'settings'

export interface DevtoolsSettings {
  /** Flight recorder window, s (0: off). */
  flight: number
  /** The frame HUD (compositor.profile.hud). */
  stats: boolean
  dials: boolean
  skeleton: boolean
  sceneReuse: boolean
  /** Write frames into Chrome DevTools' Performance panel
   * (compositor.profile.tracks). */
  tracks: boolean
  dock: 'bottom' | 'right'
  /** Panel height (bottom) or width (right), CSS px. */
  size: number
  tab: DevtoolsTab
  open: boolean
}

export interface DevtoolsOptions {
  /** Corner of the closed panel's button. Default 'bottom-right'. */
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
  /** localStorage key for the settings. Default 'compositor-gpu:devtools'. */
  storageKey?: string
  /** Settings to start from (stored ones and the URL win). */
  defaults?: Partial<DevtoolsSettings>
  /** The save shortcut, e.g. 'Alt+Shift+S' (the default); false: none. */
  shortcut?: string | false
}

export interface Devtools {
  open(tab?: DevtoolsTab): void
  close(): void
  readonly isOpen: boolean
  /** Save the flight recorder's window and show it (null: nothing to
   * save). */
  save(): Promise<Recording | null>
  /** Show a recording (from a file, the CLI, another page). */
  show(r: Recording): void
  get<K extends keyof DevtoolsSettings>(k: K): DevtoolsSettings[K]
  set<K extends keyof DevtoolsSettings>(k: K, v: DevtoolsSettings[K]): void
  destroy(): void
}

const DEFAULTS: DevtoolsSettings = {
  flight: 15,
  stats: false,
  dials: false,
  skeleton: false,
  sceneReuse: true,
  tracks: false,
  dock: 'bottom',
  size: 340,
  tab: 'timeline',
  open: false
}

const TABS: [DevtoolsTab, string][] = [
  ['live', 'Live'],
  ['timeline', 'Timeline'],
  ['elements', 'Elements'],
  ['settings', 'Settings']
]

function urlFlag(name: string): boolean | undefined {
  const q = new URLSearchParams(window.location.search)
  if (!q.has(name)) {
    return undefined
  }
  const v = q.get(name)
  return v !== '0' && v !== 'false'
}

function readStored(key: string): Partial<DevtoolsSettings> {
  try {
    const v = JSON.parse(window.localStorage.getItem(key) ?? '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
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

const inert = (): Devtools => ({
  open() {},
  close() {},
  isOpen: false,
  save: () => Promise.resolve(null),
  show() {},
  get: (k) => DEFAULTS[k],
  set() {},
  destroy() {}
})

interface Entry {
  label: string
  recording: Recording
  /** Its elements are this page's (chips outline them). */
  live: boolean
}

/** Mount the devtools for `compositor` (inert on the server). */
export function mountDevtools(
  compositor: Compositor,
  opts: DevtoolsOptions = {}
): Devtools {
  if (typeof window === 'undefined') {
    return inert()
  }
  const key = opts.storageKey ?? 'compositor-gpu:devtools'
  const gpu = compositor.active
  const profile = compositor.profile
  const settings: DevtoolsSettings = {
    ...DEFAULTS,
    dials: dialsShown(),
    ...opts.defaults,
    ...readStored(key)
  }
  for (const f of ['stats', 'dials', 'skeleton', 'tracks'] as const) {
    settings[f] = urlFlag(f) ?? settings[f]
  }
  settings.open = urlFlag('devtools') ?? settings.open
  const store = (): void => {
    try {
      window.localStorage.setItem(key, JSON.stringify(settings))
    } catch {
      // Storage blocked: settings last for this page only.
    }
  }

  // Shell.
  const host = document.createElement('div')
  host.setAttribute('data-gpu-ignore', '')
  host.setAttribute('data-compositor-devtools', '')
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CSS
  const root = h('div', { class: 'root' })
  const [fv, fh] = (opts.position ?? 'bottom-right').split('-') as [
    string,
    string
  ]
  const dot = h('span', { class: 'dot' })
  const badge = h('span', { class: 'badge' })
  const fab = h(
    'button',
    {
      class: `fab ${fv} ${fh}`,
      type: 'button',
      title: 'compositor-gpu devtools',
      'aria-expanded': 'false'
    },
    dot,
    'GPU',
    badge
  )
  const panel = h('div', {
    class: 'panel',
    role: 'region',
    'aria-label': 'compositor-gpu devtools'
  })
  panel.hidden = true
  const grip = h('div', { class: 'grip', 'aria-hidden': 'true' })
  const outline = h('div', { class: 'outline' }, h('span'))
  outline.hidden = true

  // Bar: tabs, recording picker, actions.
  const tabButtons = new Map<DevtoolsTab, HTMLButtonElement>()
  const tabs = h('div', { class: 'tabs', role: 'tablist' })
  for (const [id, label] of TABS) {
    const b = h('button', {
      class: 'tab',
      type: 'button',
      role: 'tab',
      text: label
    })
    b.addEventListener('click', () => showTab(id))
    tabButtons.set(id, b)
    tabs.append(b)
  }
  const picker = h('select', { title: 'Recording', 'aria-label': 'Recording' })
  const saveBtn = h('button', {
    class: 'btn primary',
    type: 'button',
    title: 'Save the flight recorder’s window (Alt+Shift+S)'
  })
  const recBtn = h('button', { class: 'btn', type: 'button', text: '● Record' })
  const importBtn = h('button', {
    class: 'btn',
    type: 'button',
    text: 'Import'
  })
  const exportBtn = h('button', {
    class: 'btn',
    type: 'button',
    text: 'Export'
  })
  const fitBtn = h('button', {
    class: 'btn',
    type: 'button',
    text: 'Fit',
    title: 'Show the whole recording (F)'
  })
  const closeBtn = h('button', {
    class: 'btn',
    type: 'button',
    text: '✕',
    title: 'Close (Esc)',
    'aria-label': 'Close'
  })
  const fileInput = h('input', {
    type: 'file',
    accept: '.cgprof,.json,application/json,application/gzip',
    hidden: true
  })
  const bar = h(
    'div',
    { class: 'bar' },
    tabs,
    picker,
    saveBtn,
    recBtn,
    importBtn,
    exportBtn,
    fitBtn,
    h('span', { class: 'spacer' }),
    closeBtn,
    fileInput
  )
  const status = h('div', { class: 'status' })

  // Views.
  const body = h('div', { class: 'body' })
  const liveView = new LiveView()
  const views: Record<DevtoolsTab, HTMLElement> = {
    live: h('div', { class: 'view' }, liveView.root),
    timeline: h('div', { class: 'view' }),
    elements: h('div', { class: 'view' }),
    settings: h('div', { class: 'view' })
  }
  const frameBox = h('div', { class: 'frame' })
  const timelineBox = h('div')
  views.timeline.append(timelineBox, frameBox)
  for (const v of Object.values(views)) {
    body.append(v)
  }
  const empty = (): HTMLElement =>
    h('p', {
      class: 'empty',
      text: 'No recording yet: Save the last seconds after a jank, or Record.'
    })
  frameBox.append(empty())
  views.elements.append(empty())
  panel.append(grip, bar, status, body)
  root.append(fab, panel, outline)
  shadow.append(style, root)
  document.documentElement.append(host)

  // State.
  const entries: Entry[] = []
  let current: Entry | null = null
  let model: Model | null = null
  let selected = -1
  const timeline = new Timeline(timelineBox, {
    onSelect: (i) => select(i),
    onHover: (t) => {
      status.textContent = t ?? hint()
    }
  })
  const hint = (): string =>
    model
      ? `${model.samples.length} frames, ${model.late.length} late over ${((model.end - model.start) / 1000).toFixed(1)} s. Wheel zooms, drag pans, click a frame; ← → frames, [ ] late frames.`
      : settings.flight > 0
        ? `The flight recorder keeps the last ${settings.flight} s: Save after a jank.`
        : 'The flight recorder is off (Settings).'

  // Outlining elements on the page.
  let outlined: Element | null = null
  const placeOutline = (): void => {
    if (!outlined?.isConnected) {
      outline.hidden = true
      return
    }
    const r = outlined.getBoundingClientRect()
    Object.assign(outline.style, {
      left: `${r.left - 2}px`,
      top: `${r.top - 2}px`,
      width: `${r.width + 4}px`,
      height: `${r.height + 4}px`
    })
    outline.hidden = false
  }
  const actions: FrameActions = {
    select: (i) => select(i),
    outline: (el) => {
      outlined = el === null || !model ? null : model.resolve(el)
      outline.classList.remove('flash')
      ;(outline.firstElementChild as HTMLElement).textContent =
        el === null || !model ? '' : model.path(el)
      placeOutline()
    },
    reveal: (el) => {
      const target = model?.resolve(el)
      if (!target || !model) {
        return
      }
      target.scrollIntoView({ block: 'center', behavior: 'smooth' })
      outlined = target
      ;(outline.firstElementChild as HTMLElement).textContent = model.path(el)
      outline.classList.remove('flash')
      void outline.offsetWidth
      outline.classList.add('flash')
      placeOutline()
      setTimeout(() => {
        if (outlined === target) {
          outlined = null
          placeOutline()
        }
      }, 1600)
    }
  }
  const onScroll = (): void => placeOutline()
  window.addEventListener('scroll', onScroll, { passive: true, capture: true })
  window.addEventListener('resize', onScroll, { passive: true })

  // Recordings.
  const refreshPicker = (): void => {
    picker.replaceChildren(
      ...(entries.length === 0
        ? [h('option', { text: 'No recordings yet', value: '' })]
        : entries.map((e, i) =>
            h('option', {
              value: String(i),
              text: e.label,
              selected: e === current
            })
          ))
    )
    picker.disabled = entries.length === 0
    exportBtn.disabled = current === null
    fitBtn.disabled = current === null
  }
  const describe = (r: Recording, what: string): string => {
    const rep = r.report
    const late = rep.samples.filter((s) => missed(s, rep.refreshMs) > 0).length
    const t = new Date(r.savedAt).toLocaleTimeString()
    return `${what} ${t} · ${(rep.durationMs / 1000).toFixed(1)} s · ${late} late`
  }
  const open = (e: Entry): void => {
    current = e
    model = new Model(
      e.recording,
      e.live ? (i) => profile.element(i) : () => null
    )
    timeline.setModel(model)
    // Start at the worst late frame.
    let worst = -1
    let worstDt = 0
    for (const i of model.late) {
      const d = model.hitch(i).dt
      if (d > worstDt) {
        worstDt = d
        worst = i
      }
    }
    select(worst >= 0 ? worst : model.samples.length - 1)
    renderElements(views.elements, model, actions)
    refreshPicker()
    status.textContent = hint()
  }
  const add = (e: Entry): void => {
    entries.unshift(e)
    if (entries.length > 12) {
      entries.pop()
    }
    open(e)
  }
  const select = (i: number): void => {
    if (!model) {
      return
    }
    selected = Math.max(0, Math.min(i, model.samples.length - 1))
    // The chips under the pointer go with the old view.
    actions.outline(null)
    timeline.select(selected)
    renderFrame(frameBox, model, selected, actions)
  }

  const save = async (): Promise<Recording | null> => {
    const report = await profile.save()
    if (!report || report.samples.length === 0) {
      status.textContent =
        settings.flight > 0
          ? 'Nothing to save yet.'
          : 'The flight recorder is off (Settings).'
      return null
    }
    const r = toRecording(report, 'flight')
    add({ label: describe(r, 'Saved'), recording: r, live: true })
    openPanel('timeline')
    return r
  }
  saveBtn.addEventListener('click', () => void save())
  let recording = false
  recBtn.addEventListener('click', async () => {
    if (!recording) {
      profile.start()
      recording = true
      recBtn.textContent = '■ Stop'
      recBtn.classList.add('rec')
      status.textContent = 'Recording… Stop to see it.'
      return
    }
    recording = false
    recBtn.textContent = '● Record'
    recBtn.classList.remove('rec')
    const report = await profile.stop()
    if (report) {
      const r = toRecording(report, 'recording')
      add({ label: describe(r, 'Recorded'), recording: r, live: true })
      openPanel('timeline')
    }
  })
  picker.addEventListener('change', () => {
    const e = entries[Number(picker.value)]
    if (e) {
      open(e)
    }
  })
  fitBtn.addEventListener('click', () => timeline.fit())
  exportBtn.addEventListener('click', async () => {
    if (!current) {
      return
    }
    const bytes = await encodeRecording(current.recording)
    const url = URL.createObjectURL(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/gzip' })
    )
    const a = h('a', {
      href: url,
      download: recordingFileName(current.recording)
    })
    shadow.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
  const importFile = async (f: File): Promise<void> => {
    try {
      const r = await decodeRecording(await f.arrayBuffer())
      add({ label: `${f.name}`, recording: r, live: false })
      openPanel('timeline')
    } catch (err) {
      status.textContent = `Couldn't open ${f.name}: ${(err as Error).message}`
    }
  }
  importBtn.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0]
    if (f) {
      void importFile(f)
    }
    fileInput.value = ''
  })
  body.addEventListener('dragover', (e) => {
    e.preventDefault()
    body.setAttribute('data-drop', '')
  })
  body.addEventListener('dragleave', () => body.removeAttribute('data-drop'))
  body.addEventListener('drop', (e) => {
    e.preventDefault()
    body.removeAttribute('data-drop')
    const f = e.dataTransfer?.files[0]
    if (f) {
      void importFile(f)
    }
  })

  // Settings.
  const applySettings = (): void => {
    profile.flight(
      gpu && settings.flight > 0 ? { seconds: settings.flight } : false
    )
    if (gpu) {
      profile.hud(settings.stats)
      compositor.skeleton = settings.skeleton
      compositor.sceneReuse = settings.sceneReuse
      profile.tracks(settings.tracks)
    }
    setDialsShown(settings.dials)
    saveBtn.textContent =
      settings.flight > 0 ? `Save last ${settings.flight} s` : 'Save'
    saveBtn.disabled = !gpu || settings.flight <= 0
    recBtn.disabled = !gpu
    panel.className = `panel ${settings.dock}`
    panel.style.height = settings.dock === 'bottom' ? `${settings.size}px` : ''
    panel.style.width = settings.dock === 'right' ? `${settings.size}px` : ''
  }
  const renderSettings = (): void => {
    const box = h('div', { class: 'settings' })
    const toggle = (
      k: 'stats' | 'dials' | 'skeleton' | 'sceneReuse' | 'tracks',
      label: string,
      hint: string,
      usable = gpu
    ): void => {
      const input = h('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': label
      })
      input.checked = settings[k]
      input.disabled = !usable
      input.addEventListener('change', () => set(k, input.checked))
      box.append(
        h(
          'label',
          { class: `setting${usable ? '' : ' off'}` },
          h(
            'span',
            {},
            h('div', { text: label }),
            h('div', { class: 'hint', text: hint })
          ),
          input
        )
      )
    }
    const secs = h('input', {
      type: 'number',
      min: 0,
      max: 120,
      step: 1,
      'aria-label': 'Flight recorder seconds'
    })
    secs.value = String(settings.flight)
    secs.disabled = !gpu
    secs.addEventListener('change', () =>
      set('flight', Math.max(0, Math.min(120, Number(secs.value) || 0)))
    )
    box.append(
      h(
        'label',
        { class: `setting${gpu ? '' : ' off'}` },
        h(
          'span',
          {},
          h('div', { text: 'Flight recorder' }),
          h('div', { class: 'hint', text: 'Seconds kept for Save (0: off)' })
        ),
        secs
      )
    )
    toggle(
      'tracks',
      'Chrome DevTools tracks',
      'Frames, compositor phases, GPU and late frames in the Performance panel'
    )
    toggle('stats', 'Frame HUD', 'The corner graph (compositor.profile.hud)')
    toggle('dials', 'Dials', 'Effect parameter panels', true)
    toggle('skeleton', 'Skeleton', 'Geometry as wireframe')
    if (settings.skeleton && gpu) {
      const legend = h('div', { class: 'legend' })
      for (const [name, color] of Object.entries(SKELETON_COLORS)) {
        const sw = h('i')
        sw.style.borderColor = color
        legend.append(h('span', {}, sw, name))
      }
      box.append(legend)
    }
    toggle(
      'sceneReuse',
      'Scene reuse',
      'Reuse the last frame’s scene when only effects change'
    )
    const dock = h('select', { 'aria-label': 'Dock' })
    for (const d of ['bottom', 'right'] as const) {
      dock.append(
        h('option', { value: d, text: d, selected: settings.dock === d })
      )
    }
    dock.addEventListener('change', () =>
      set('dock', dock.value as 'bottom' | 'right')
    )
    box.append(
      h(
        'label',
        { class: 'setting' },
        h(
          'span',
          {},
          h('div', { text: 'Dock' }),
          h('div', { class: 'hint', text: 'Where the panel sits' })
        ),
        dock
      )
    )
    if (!gpu) {
      box.append(
        h('div', {
          class: 'note',
          text: 'No WebGPU: the compositor is inactive (only Dials work).'
        })
      )
    }
    views.settings.replaceChildren(box)
  }
  const set = <K extends keyof DevtoolsSettings>(
    k: K,
    v: DevtoolsSettings[K]
  ): void => {
    settings[k] = v
    applySettings()
    if (k !== 'size' && k !== 'tab' && k !== 'open') {
      renderSettings()
    }
    store()
  }

  // Tabs, opening and closing.
  let loop = 0
  const tick = (): void => {
    loop = 0
    if (panel.hidden || settings.tab !== 'live') {
      return
    }
    liveView.draw(profile.recent())
    loop = requestAnimationFrame(tick)
  }
  const showTab = (t: DevtoolsTab): void => {
    settings.tab = t
    actions.outline(null)
    for (const [id, b] of tabButtons) {
      b.setAttribute('aria-selected', String(id === t))
      views[id].hidden = id !== t
    }
    if (t === 'settings') {
      renderSettings()
    }
    if (t === 'live' && !loop) {
      loop = requestAnimationFrame(tick)
    }
    status.textContent = hint()
    store()
  }
  const openPanel = (t?: DevtoolsTab): void => {
    panel.hidden = false
    fab.hidden = true
    settings.open = true
    showTab(t ?? settings.tab)
  }
  const closePanel = (): void => {
    panel.hidden = true
    fab.hidden = false
    settings.open = false
    actions.outline(null)
    store()
    fab.focus()
  }
  fab.addEventListener('click', () => openPanel())
  closeBtn.addEventListener('click', closePanel)

  // Resizing.
  grip.addEventListener('pointerdown', (e) => {
    grip.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => {
      settings.size =
        settings.dock === 'bottom'
          ? Math.max(
              160,
              Math.min(window.innerHeight - 40, window.innerHeight - ev.clientY)
            )
          : Math.max(
              280,
              Math.min(window.innerWidth - 40, window.innerWidth - ev.clientX)
            )
      applySettings()
    }
    const up = (): void => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      store()
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
  })

  // Keys: in the panel, frame navigation; anywhere, the save shortcut.
  const shortcut = opts.shortcut ?? 'Alt+Shift+S'
  const onKey = (e: KeyboardEvent): void => {
    const path = e.composedPath()
    const inPanel = path.includes(panel)
    const t = path[0]
    const typing =
      t instanceof HTMLElement &&
      (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
    if (shortcut && !typing && matchShortcut(e, shortcut)) {
      e.preventDefault()
      void save()
      return
    }
    if (!inPanel || typing || panel.hidden) {
      return
    }
    if (e.key === 'Escape') {
      closePanel()
    } else if (settings.tab === 'timeline' && model) {
      const m = model
      if (e.key === 'ArrowLeft') {
        select(selected - 1)
      } else if (e.key === 'ArrowRight') {
        select(selected + 1)
      } else if (e.key === '[') {
        const k = [...m.late].reverse().find((x) => x < selected)
        if (k !== undefined) {
          select(k)
        }
      } else if (e.key === ']') {
        const k = m.late.find((x) => x > selected)
        if (k !== undefined) {
          select(k)
        }
      } else if (e.key === 'f') {
        timeline.fit()
      } else {
        return
      }
      e.preventDefault()
    }
  }
  document.addEventListener('keydown', onKey, true)

  // The button's dot: green while recording, red after a late frame in
  // the last two seconds; the badge counts late frames in the window.
  const watch = setInterval(() => {
    if (!gpu || !fab.isConnected) {
      return
    }
    const frames = profile.recent()
    const now = performance.now()
    const refresh = estimateRefresh(frames)
    let recent = false
    let late = 0
    for (const s of frames) {
      if (missed(s, refresh) > 0) {
        late++
        if (now - s.t < 2000) {
          recent = true
        }
      }
    }
    dot.className = `dot${recent ? ' jank' : settings.flight > 0 ? ' on' : ''}`
    badge.textContent = late > 0 ? String(late) : ''
    fab.title =
      late > 0
        ? `${late} late frames recently: open to save them`
        : 'compositor-gpu devtools'
  }, 500)

  applySettings()
  refreshPicker()
  if (settings.open) {
    openPanel()
  }

  return {
    open: (t) => openPanel(t),
    close: closePanel,
    get isOpen() {
      return !panel.hidden
    },
    save,
    show: (r) => {
      add({
        label: describe(r, r.kind === 'flight' ? 'Saved' : 'Recorded'),
        recording: r,
        live: false
      })
      openPanel('timeline')
    },
    get: (k) => settings[k],
    set,
    destroy() {
      clearInterval(watch)
      if (loop) {
        cancelAnimationFrame(loop)
      }
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      timeline.destroy()
      if (recording) {
        void profile.stop()
      }
      profile.flight(false)
      profile.tracks(false)
      host.remove()
    }
  }
}
