// The devtools' view of a recording (docs/PROFILER.md, M6b): a report
// plus what the views keep asking of it (the refresh interval, frames
// by time, hitches for any frame, element paths, costs by element and by
// GPU label). Works the same on a live report from the flight recorder
// and on an imported file (where no element is live).

import {
  estimateRefresh,
  type FrameSample,
  type Hitch,
  hitchAt,
  missed,
  type ProfileReport
} from '../profile/profiler'
import type { Recording } from '../profile/recording'

export const PHASES = ['read', 'hooks', 'upload', 'encode', 'other'] as const
export type Phase = (typeof PHASES)[number]

export const COLORS = {
  read: '#f59e0b',
  hooks: '#a78bfa',
  upload: '#38bdf8',
  encode: '#34d399',
  other: '#9ca3af',
  gpu: '#e5e7eb',
  late: '#ef4444',
  ok: 'rgba(255,255,255,0.18)',
  skipped: 'rgba(255,255,255,0.07)',
  script: '#f472b6',
  layout: '#c084fc',
  loaf: 'rgba(244,114,182,0.22)',
  unattributed: '#6b7280',
  compositor: '#9ca3af',
  mark: '#38bdf8'
} as const

export const FACTOR_COLORS: Record<string, string> = {
  read: COLORS.read,
  upload: COLORS.upload,
  encode: COLORS.encode,
  hooks: COLORS.hooks,
  compositor: COLORS.compositor,
  gpu: COLORS.gpu,
  script: COLORS.script,
  layout: COLORS.layout,
  unattributed: COLORS.unattributed
}

export const fmtMs = (v: number, digits = 1): string =>
  `${v.toFixed(digits)} ms`

export const fmtAt = (ms: number): string => `+${(ms / 1000).toFixed(2)} s`

/** A recording opened in the devtools. */
export class Model {
  readonly report: ProfileReport
  readonly refresh: number
  readonly origin: number
  readonly samples: readonly FrameSample[]
  /** Indexes of the late frames, in time order. */
  readonly late: number[]
  /** First and last time, ms after origin. */
  readonly start: number
  readonly end: number
  private hitchCache = new Map<number, Hitch>()
  private images = new Map<number, HTMLImageElement>()

  constructor(
    readonly recording: Recording,
    /** The live element behind an index (null for imported ones). */
    readonly resolve: (i: number) => Element | null = () => null
  ) {
    const r = recording.report
    this.report = r
    this.samples = r.samples
    this.origin = r.origin ?? r.samples[0]?.t ?? 0
    this.refresh = r.refreshMs || estimateRefresh(r.samples)
    this.late = []
    r.samples.forEach((s, i) => {
      if (missed(s, this.refresh) > 0) {
        this.late.push(i)
      }
    })
    const first = r.samples[0]
    const last = r.samples[r.samples.length - 1]
    // From the first frame's interval, unless it follows an idle gap.
    this.start = first
      ? first.t - Math.min(first.dt, this.refresh * 3) - this.origin
      : 0
    this.end = last ? last.t - this.origin : 1
  }

  /** Filmstrip picture k as an image (loading; `onload` once it is). */
  image(k: number, onload?: () => void): HTMLImageElement | null {
    const f = this.report.filmstrip?.[k]
    if (!f) {
      return null
    }
    let img = this.images.get(k)
    if (!img) {
      img = new Image()
      if (onload) {
        img.onload = onload
      }
      img.src = f.src
      this.images.set(k, img)
    }
    return img
  }

  /** The filmstrip pictures nearest before and after time `t`. */
  picturesAround(t: number): { before: number; after: number } {
    const film = this.report.filmstrip ?? []
    let before = -1
    let after = -1
    film.forEach((f, k) => {
      if (f.at <= t) {
        before = k
      } else if (after < 0) {
        after = k
      }
    })
    return { before, after }
  }

  /** ms after origin of sample i. */
  at(i: number): number {
    return (this.samples[i]?.t ?? this.origin) - this.origin
  }

  path(i: number): string {
    return this.report.elements?.[i] ?? `element ${i}`
  }

  /** The gap before frame i and what contributed (cached). */
  hitch(i: number): Hitch {
    let h = this.hitchCache.get(i)
    if (!h) {
      h = hitchAt(
        this.samples,
        i,
        this.refresh,
        this.origin,
        this.report.longFrames,
        (k) => this.report.elements?.[k]
      )
      this.hitchCache.set(i, h)
    }
    return h
  }

  /** The frame whose interval holds time `t` (ms after origin), or the
   * nearest. */
  frameAt(t: number): number {
    const abs = t + this.origin
    const s = this.samples
    let lo = 0
    let hi = s.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((s[mid]?.t ?? 0) < abs) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    return Math.max(0, lo)
  }

  /** Per element over the recording: frames that re-read it (as a scope),
   * invalidations it was the target of, and a share of the read time
   * (each frame's read split evenly over its scopes). Largest first. */
  elementCosts(): ElementCost[] {
    const by = new Map<number, ElementCost>()
    const get = (el: number): ElementCost => {
      let c = by.get(el)
      if (!c) {
        c = {
          el,
          path: this.path(el),
          reads: 0,
          readMs: 0,
          events: 0,
          kinds: {}
        }
        by.set(el, c)
      }
      return c
    }
    for (const s of this.samples) {
      const why = s.why
      if (!why) {
        continue
      }
      const share = why.scopes.length ? s.cpu.read / why.scopes.length : 0
      for (const el of why.scopes) {
        const c = get(el)
        c.reads++
        c.readMs += share
      }
      for (const e of why.events) {
        if (e.el === undefined) {
          continue
        }
        const c = get(e.el)
        const n = e.n ?? 1
        c.events += n
        const k = e.detail ? `${e.kind}[${e.detail}]` : e.kind
        c.kinds[k] = (c.kinds[k] ?? 0) + n
      }
    }
    return [...by.values()].sort(
      (a, b) => b.readMs - a.readMs || b.events - a.events
    )
  }

  /** Per GPU pass label: frames it ran in, total and worst ms. */
  gpuCosts(): LabelCost[] {
    const by = new Map<string, LabelCost>()
    for (const s of this.samples) {
      const sums = new Map<string, number>()
      for (const sp of s.gpu?.spans ?? []) {
        sums.set(sp.label, (sums.get(sp.label) ?? 0) + sp.ms)
      }
      for (const [label, ms] of sums) {
        let c = by.get(label)
        if (!c) {
          c = { label, frames: 0, totalMs: 0, maxMs: 0 }
          by.set(label, c)
        }
        c.frames++
        c.totalMs += ms
        c.maxMs = Math.max(c.maxMs, ms)
      }
    }
    return [...by.values()].sort((a, b) => b.totalMs - a.totalMs)
  }

  /** Per effect (pass, layer, material, trail): frames it kept the loop
   * running (FrameWhy.alive) and its own GPU passes' time (labels
   * `fx:<name>` and `fx:<name>#k`). Busiest first. */
  effectCosts(): EffectCost[] {
    const by = new Map<string, EffectCost>()
    const get = (kind: string, name: string): EffectCost => {
      let e = by.get(name)
      if (!e) {
        e = { kind, name, frames: 0, gpuMs: 0, gpuFrames: 0 }
        by.set(name, e)
      }
      return e
    }
    for (const s of this.samples) {
      for (const a of s.why?.alive ?? []) {
        const m =
          /^(pass|layer|material|trail) (.+?)( \((busy|pointer)\))?$/.exec(a)
        if (m?.[1] && m[2]) {
          get(m[1], m[2]).frames++
        }
      }
    }
    for (const c of this.gpuCosts()) {
      const m = /^fx:(.+?)(#\d+)?$/.exec(c.label)
      if (m?.[1] && m[1] !== 'snapshot') {
        const e = get(by.get(m[1])?.kind ?? 'pass', m[1])
        e.gpuMs += c.totalMs
        e.gpuFrames = Math.max(e.gpuFrames, c.frames)
      }
    }
    return [...by.values()].sort(
      (a, b) => b.gpuMs - a.gpuMs || b.frames - a.frames
    )
  }

  /** What kept the loop running, by name: frames it was named in. */
  aliveCosts(): [string, number][] {
    const by = new Map<string, number>()
    for (const s of this.samples) {
      for (const a of s.why?.alive ?? []) {
        by.set(a, (by.get(a) ?? 0) + 1)
      }
    }
    return [...by].sort((a, b) => b[1] - a[1])
  }
}

export interface ElementCost {
  el: number
  path: string
  /** Frames that re-read it. */
  reads: number
  readMs: number
  /** Invalidations aimed at it, and by kind. */
  events: number
  kinds: Record<string, number>
}

export interface EffectCost {
  kind: string
  name: string
  /** Frames it kept the loop running. */
  frames: number
  gpuMs: number
  /** Frames its passes ran in. */
  gpuFrames: number
}

export interface LabelCost {
  label: string
  frames: number
  totalMs: number
  maxMs: number
}

/** Build a DOM element: `h('div', { class: 'x' }, child, 'text')`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) {
      continue
    }
    if (k === 'class') {
      el.className = String(v)
    } else if (k === 'text') {
      el.textContent = String(v)
    } else {
      el.setAttribute(k, v === true ? '' : String(v))
    }
  }
  for (const c of children) {
    if (c !== null && c !== undefined && c !== false) {
      el.append(c)
    }
  }
  return el
}
