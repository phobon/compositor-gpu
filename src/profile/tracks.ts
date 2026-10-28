// The compositor in Chrome DevTools' Performance panel (docs/PROFILER.md,
// M6c): while on (`profile.tracks(true)`), each frame is written as
// custom track entries in a "compositor-gpu" track group, lined up with
// the browser's own main thread, layout, paint and GC:
//
//   Frames      each frame's interval (red when late)
//   Compositor  its frame callback by phase: read, hooks, upload, encode,
//               other
//   GPU         its GPU time, after its CPU work (GPU timestamps don't
//               share the page clock: the place is approximate, the
//               length measured)
//
// and a marker on each late frame (its hitch factors as the tooltip,
// written a little later so the browser's long animation frames are in)
// and on each profile.mark().
//
// High-frequency entries go through `console.timeStamp(label, start,
// end, track, group, color)` (Chrome 133+: no buffering, little cost);
// markers, and every entry on an older Chromium, through
// `performance.measure` / `mark` with `detail.devtools` (Chrome 129+),
// cleared right after so the page's timeline buffer doesn't grow. Other
// browsers ignore the detail; tracks are meant for Chromium.

import { factorsText } from './explain'
import type { FrameSample, Hitch } from './profiler'

export const TRACK_GROUP = 'compositor-gpu'

type Color =
  | 'primary'
  | 'primary-light'
  | 'primary-dark'
  | 'secondary'
  | 'secondary-light'
  | 'secondary-dark'
  | 'tertiary'
  | 'tertiary-light'
  | 'tertiary-dark'
  | 'error'

const PHASE_COLOR: Record<string, Color> = {
  read: 'tertiary',
  hooks: 'secondary-light',
  upload: 'primary',
  encode: 'secondary',
  other: 'tertiary-light'
}

/** Chromium 133+ (console.timeStamp takes a track). */
function timeStampTracks(): boolean {
  const nav = navigator as Navigator & {
    userAgentData?: { brands?: { brand: string; version: string }[] }
  }
  const brand = nav.userAgentData?.brands?.find((b) => b.brand === 'Chromium')
  return brand !== undefined && Number(brand.version) >= 133
}

type Props = [string, string][]

export class DevtoolsTracks {
  private readonly stamp: boolean

  constructor() {
    this.stamp = typeof console.timeStamp === 'function' && timeStampTracks()
  }

  private entry(
    label: string,
    start: number,
    end: number,
    track: string,
    color: Color,
    tooltip?: string,
    properties?: Props
  ): void {
    if (end <= start) {
      return
    }
    if (this.stamp && !tooltip) {
      ;(console.timeStamp as unknown as (...a: (string | number)[]) => void)(
        label,
        start,
        end,
        track,
        TRACK_GROUP,
        color
      )
      return
    }
    const name = `${TRACK_GROUP}: ${label}`
    try {
      performance.measure(name, {
        start,
        end,
        detail: {
          devtools: {
            dataType: 'track-entry',
            track,
            trackGroup: TRACK_GROUP,
            color,
            tooltipText: tooltip ?? label,
            properties
          }
        }
      })
      performance.clearMeasures(name)
    } catch {
      // A start before the time origin (or an old browser): skip it.
    }
  }

  private marker(
    label: string,
    at: number,
    color: Color,
    tooltip: string,
    properties?: Props
  ): void {
    const name = `${TRACK_GROUP}: ${label}`
    try {
      performance.mark(name, {
        startTime: at,
        detail: {
          devtools: {
            dataType: 'marker',
            color,
            tooltipText: tooltip,
            properties
          }
        }
      })
      performance.clearMarks(name)
    } catch {
      // As entry().
    }
  }

  /** A frame and its compositor phases. */
  frame(s: FrameSample, late: boolean): void {
    this.entry(
      late ? `late frame ${s.id}` : `frame ${s.id}`,
      s.t - s.dt,
      s.t,
      'Frames',
      late ? 'error' : 'primary-light'
    )
    let t = s.start ?? s.t
    for (const k of ['read', 'hooks', 'upload', 'encode', 'other'] as const) {
      const v = s.cpu[k]
      if (v < 0.01) {
        continue
      }
      const label =
        k === 'read' && s.read !== 'none'
          ? `${s.read} read, ${s.readElements} el${s.cause ? ` (${s.cause})` : ''}`
          : k
      this.entry(label, t, t + v, 'Compositor', PHASE_COLOR[k] ?? 'primary')
      t += v
    }
  }

  /** A frame's GPU time, once its timings land. */
  gpu(s: FrameSample): void {
    const g = s.gpu
    if (!g || g.totalMs <= 0) {
      return
    }
    const start = (s.start ?? s.t) + s.cpu.total
    const top = [...g.spans].sort((a, b) => b.ms - a.ms).slice(0, 3)
    this.entry(
      `${top.map((p) => `${p.label} ${p.ms.toFixed(1)}`).join(', ')} ms`,
      start,
      start + g.totalMs,
      'GPU',
      'secondary-dark'
    )
  }

  /** A late frame's marker, its factors as the tooltip. */
  hitch(s: FrameSample, h: Hitch): void {
    const fs = h.factors ?? []
    this.marker(
      `late frame ${s.id}: ${h.missed} missed (${h.cause})`,
      s.t,
      'error',
      `${h.dt.toFixed(1)} ms gap, ${h.missed} missed — ${factorsText(fs)}`,
      fs
        .slice(0, 6)
        .map((f): [string, string] => [
          `${f.kind} ${f.ms.toFixed(1)} ms`,
          `${f.text}${f.source ? ` <${f.source}>` : ''}`
        ])
    )
  }

  /** A profile.mark(). */
  mark(label: string, at: number): void {
    this.marker(label, at, 'primary-dark', label)
  }
}
