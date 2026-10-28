// `compositor-gpu/debug`: the debug toggles (stats HUD, dials, skeleton)
// for one compositor. Now a thin alias for `compositor-gpu/devtools`
// (docs/PROFILER.md), whose Settings tab holds the same toggles next to
// the profiler: mountDebugPanel mounts the devtools and maps the flags
// onto its settings. The URL seeds them as before (`?stats=1`,
// `?dials=0`, a bare `?skeleton` is on).

import { type Devtools, mountDevtools } from '../devtools'
import type { Compositor } from '../types'

export type DebugFlag = 'stats' | 'dials' | 'skeleton'

export interface DebugPanelOptions {
  /** Corner of the viewport. Default 'bottom-right'. */
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
  /** localStorage key for the settings. Default 'compositor-gpu:devtools'. */
  storageKey?: string
}

export interface DebugPanel {
  get(flag: DebugFlag): boolean
  set(flag: DebugFlag, on: boolean): void
  /** Remove the panel; the flags stay as they are. */
  destroy(): void
  /** The devtools behind it. */
  readonly devtools: Devtools
}

/** Mount the devtools for `compositor` with the debug flags' API; inert
 * on the server. */
export function mountDebugPanel(
  compositor: Compositor,
  opts: DebugPanelOptions = {}
): DebugPanel {
  const d = mountDevtools(compositor, {
    position: opts.position,
    storageKey: opts.storageKey
  })
  return {
    get: (flag) => d.get(flag),
    set: (flag, on) => d.set(flag, on),
    destroy: () => d.destroy(),
    devtools: d
  }
}
