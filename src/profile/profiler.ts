// The frame profiler (compositor.profile): a sample per compositor frame
// with its CPU breakdown, what the DOM read did and why, and the GPU pass
// timings when the device has timestamp-query. Recording collects a
// session and reports percentiles, dropped frames and the likely cause of
// each hitch; the HUD (profile/hud.ts) draws the most recent frames live.
// The flight recorder keeps the last seconds the same way, for save()
// after the fact (docs/PROFILER.md). Each sample says why the frame did
// what it did (profile/trace.ts) and each hitch lists what contributed
// (profile/explain.ts). Nothing is sampled while none of these is on.

import type { GpuFrameTiming, GpuSpan } from '../gpu/timer'
import type { Layer } from '../types'
import { causeOf, explain, type Factor, factorsText } from './explain'
import { Hud } from './hud'
import {
  ElementRegistry,
  type FrameWhy,
  MAX_SCOPES,
  TraceBuffer
} from './trace'
import { DevtoolsTracks } from './tracks'

export type ReadKind = 'none' | 'full' | 'partial' | 'escalated'

/** CPU wall time inside the compositor's frame callback, ms. */
export interface CpuBreakdown {
  total: number
  /** DOM read (full or partial). */
  read: number
  /** Effects hooks (beforeFrame, onFrame, onGlyph). */
  hooks: number
  /** Instance buffer uploads. */
  upload: number
  /** Command encoding and submit. */
  encode: number
  /** Part of `encode`: recomputing draw culling (0 when reused). */
  cull: number
  /** Part of `read`: rebuilding the scene from the element tree
   * (flatten, paint order, batches). */
  scene: number
  /** Part of `scene`: building the draw batches. */
  batches: number
  /** Part of `upload`: the text layer. */
  text: number
  /** The rest: dirty tracking, canvas placement, bookkeeping. */
  other: number
}

export interface FrameSample {
  /** Renderer frame number (GpuFrameTiming.frame). */
  id: number
  /** rAF timestamp, ms. */
  t: number
  /** performance.now() when the compositor's frame callback began (its
   * script in a long animation frame); absent in older reports. */
  start?: number
  /** ms since the previous compositor frame. */
  dt: number
  /** The previous frame asked for this one, so `dt` measures pacing (a
   * long one is a dropped frame) rather than an idle gap. */
  continuous: boolean
  /** ms after the previous frame that this one was requested (0 when
   * continuous). Requested within a refresh interval, `dt` still measures
   * pacing (see paced()). */
  requested: number
  /** ms from the request to this frame: over a refresh interval means
   * the frame came late even after an idle gap. */
  wait: number
  cpu: CpuBreakdown
  read: ReadKind
  /** Why the read happened: a full read's dirty flags and the last
   * mutation; an escalation's reason and boundary. */
  cause: string
  readElements: number
  /** Upload ms per re-uploaded layer. */
  uploads: Partial<Record<Layer, number>>
  batches: number
  draws: number
  groups: number
  /** The post chain ran on the previous frame's scene (no main pass). */
  reused: boolean
  /** Nothing was drawn (CompositorOptions.skipUnchanged); absent in
   * reports from before 2026-10-16. */
  skipped?: boolean
  /** Filled in a frame or two later; null without timestamp-query. */
  gpu: GpuFrameTiming | null
  /** What triggered the frame's work and kept the loop running; absent
   * in reports from before 2026-10-28. */
  why?: FrameWhy
}

export interface ProfileOptions {
  /** Refresh interval, ms; estimated from the frames when omitted. */
  refreshMs?: number
  /** Time GPU passes (when available). Default true. */
  gpu?: boolean
}

/** Percentiles of a series, ms. */
export interface Pct {
  n: number
  mean: number
  p50: number
  p95: number
  p99: number
  max: number
}

/** A late frame and what most likely made it late. */
export interface Hitch {
  /** ms since the recording started. */
  at: number
  dt: number
  /** Refresh intervals missed. */
  missed: number
  /** The largest factor's category: 'compositor cpu', 'gpu', 'script',
   * 'outside' (layout, paint, GC or script the browser didn't
   * attribute). */
  cause: 'compositor cpu' | 'gpu' | 'script' | 'outside'
  /** The largest factors as one line. */
  detail: string
  /** Everything recorded that contributed, largest first (absent in
   * reports from before 2026-10-28). */
  factors?: Factor[]
  /** The frame before the gap (its work delayed this one). */
  before: FrameSample | null
}

/** A long animation frame (PerformanceLongAnimationFrameTiming). */
export interface LongFrame {
  /** ms since the recording started. */
  at: number
  duration: number
  blocking: number
  /** Style/layout and render time at the end of the frame, ms. */
  layout: number
  render: number
  /** The longest scripts (up to 5): invoker and source, ms. */
  scripts: LongFrameScript[]
}

export interface LongFrameScript {
  name: string
  ms: number
  /** Start, ms since the recording started (as LongFrame.at). */
  at?: number
  /** Source url (and `:char` position). */
  source?: string
  /** invokerType: 'user-callback', 'event-listener', 'classic-script',
   * 'module-script', 'resolve-promise', 'reject-promise'. */
  type?: string
  /** Forced style and layout inside it, ms. */
  forced?: number
}

export interface ProfileSummary {
  frames: number
  durationMs: number
  refreshMs: number
  /** Frame pacing over continuous frames. */
  dt: Pct
  /** Frames later than 1.5 refresh intervals, and the intervals missed. */
  late: number
  dropped: number
  /** Frames that drew nothing (skipUnchanged). */
  skipped?: number
  cpu: Record<keyof CpuBreakdown, Pct>
  /** GPU frame time and per pass label (summed per frame); null without
   * timestamp-query. */
  gpu: {
    total: Pct
    /** Per label: its passes' begin-to-end times, summed per frame. */
    passes: Record<string, Pct>
    /** Per label: the time per frame its passes ran while no other
     * label's pass did (absent in reports from before 2026-10-14). */
    alone?: Record<string, Pct>
  } | null
  reads: Record<ReadKind, number> & {
    /** Escalation reasons and full-read causes, by count. */
    causes: Record<string, number>
    elements: Pct
  }
  hitches: Hitch[]
}

export interface ProfileReport extends ProfileSummary {
  gpuTiming: boolean
  /** Summaries between consecutive marks. */
  phases: { label: string; summary: ProfileSummary }[]
  marks: { at: number; label: string }[]
  longFrames: LongFrame[]
  samples: FrameSample[]
  env: {
    dpr: number
    width: number
    height: number
    userAgent: string
    /** The page URL, the GPU adapter and the compositor's mode (absent
     * in reports from before 2026-10-28). */
    url?: string
    adapter?: string
    mode?: string
  }
  /** Element paths by ElementRegistry index, for the elements the
   * samples and hitches name. */
  elements?: Record<number, string>
  /** performance.now() at the recording's start: `at` times are ms
   * after it; sample `t` and `start` are absolute. */
  origin?: number
}

/** The compositor side the profiler drives. */
export interface ProfileHost {
  setGpuTiming(onResult: ((t: GpuFrameTiming) => void) | null): boolean
  gpuTimingPending(): number
  requestFrame(): void
  /** Scene reuse (Compositor.sceneReuse), for the HUD's A/B key. */
  sceneReuse(): boolean
  setSceneReuse(on: boolean): void
  /** Start (a sink) or stop (null) reporting invalidations. */
  setTrace?(
    sink: ((kind: string, node?: Node | null, detail?: string) => void) | null
  ): void
  /** The GPU adapter and the compositor's mode, for report.env. */
  describe?(): { adapter?: string; mode?: string }
}

/** Raw why for a frame, from the compositor (Profiler.push). */
export interface FrameWhyInput {
  /** Re-read scope roots. */
  scopes: Iterable<Element>
  scopeCount: number
  alive: string[]
}

/** compositor.profile */
export interface Profile {
  /** Start a recording (replacing one in progress). */
  start(opts?: ProfileOptions): void
  /** End the recording; resolves once in-flight GPU timings land. Null
   * when nothing was recording. */
  stop(): Promise<ProfileReport | null>
  /** Label the frames from now on (a phase in the report). */
  mark(label: string): void
  readonly recording: boolean
  /** Show or hide the live HUD (toggles without an argument). Returns
   * whether it is shown. */
  hud(on?: boolean): boolean
  /** The most recent frames (up to RING), oldest first. */
  recent(): FrameSample[]
  /** Keep the last `seconds` (default 15) of frames, long animation
   * frames, marks and invalidations, for save(); false stops. */
  flight(on: boolean | { seconds?: number }): void
  /** The flight recorder is on. */
  readonly flying: boolean
  /** The flight recorder's window as a report (the frames before now);
   * null when it is off or has no frames. Resolves once their GPU
   * timings land. */
  save(): Promise<ProfileReport | null>
  /** The live element behind a report's element index, while it is still
   * in the document. */
  element(i: number): Element | null
  /** Write frames, compositor phases, GPU time and late-frame markers
   * (with their factors) into Chrome DevTools' Performance panel as
   * custom tracks (profile/tracks.ts); false stops. */
  tracks(on: boolean): void
  /** The DevTools tracks are on. */
  readonly tracking: boolean
}

const RING = 240
const COMMON_REFRESH = [
  1000 / 240,
  1000 / 165,
  1000 / 144,
  1000 / 120,
  1000 / 90,
  1000 / 75,
  1000 / 60,
  1000 / 50,
  1000 / 30
]

export class Profiler implements Profile {
  /** Sampling is on (a recording, the flight recorder or the HUD). */
  active = false
  private readonly ring: (FrameSample | null)[] = new Array(RING).fill(null)
  private head = 0
  private session: FrameSample[] | null = null
  private opts: ProfileOptions = {}
  private startedAt = 0
  /** Absolute times (performance.now). */
  private marks: { at: number; label: string }[] = []
  private longFrames: LongFrame[] = []
  private observer: PerformanceObserver | null = null
  private view: Hud | null = null
  private gpuOn = false
  private traceOn = false
  private readonly registry = new ElementRegistry()
  private readonly trace = new TraceBuffer(this.registry)
  /** Flight window, ms (0: off), and its frames. */
  private flightMs = 0
  private flightFrames: FrameSample[] = []
  private devtools: DevtoolsTracks | null = null
  /** Late frames waiting for their long animation frames (tracks). */
  private lateQueue: { s: FrameSample; at: number }[] = []
  private trackRefresh = 1000 / 60
  private trackRefreshAt = 0

  constructor(private readonly host: ProfileHost) {}

  get recording(): boolean {
    return this.session !== null
  }

  get flying(): boolean {
    return this.flightMs > 0
  }

  get tracking(): boolean {
    return this.devtools !== null
  }

  tracks(on: boolean): void {
    this.devtools = on ? (this.devtools ?? new DevtoolsTracks()) : null
    this.lateQueue = []
    this.update()
  }

  start(opts: ProfileOptions = {}): void {
    this.opts = opts
    this.session = []
    this.startedAt = performance.now()
    if (!this.flying) {
      this.marks = []
      this.longFrames = []
    }
    this.update()
  }

  async stop(): Promise<ProfileReport | null> {
    const session = this.session
    if (!session) {
      return null
    }
    await this.gpuSettled()
    this.session = null
    const report = this.report(session, this.startedAt)
    this.update()
    return report
  }

  flight(on: boolean | { seconds?: number }): void {
    const seconds = on === false ? 0 : on === true ? 15 : (on.seconds ?? 15)
    this.flightMs = Math.max(0, seconds) * 1000
    if (!this.flying) {
      this.flightFrames = []
    }
    this.update()
  }

  async save(): Promise<ProfileReport | null> {
    if (!this.flying) {
      return null
    }
    await this.gpuSettled()
    this.trim(performance.now())
    const frames = [...this.flightFrames]
    const first = frames[0]
    if (!first) {
      return null
    }
    // From just before the first frame, so its interval is inside.
    return this.report(frames, first.t - first.dt)
  }

  element(i: number): Element | null {
    return this.registry.get(i)
  }

  mark(label: string): void {
    const at = performance.now()
    if (this.session || this.flying) {
      this.marks.push({ at, label })
    }
    this.devtools?.mark(label, at)
  }

  hud(on?: boolean): boolean {
    const show = on ?? !this.view
    if (show && !this.view) {
      this.view = new Hud(this.host)
    } else if (!show && this.view) {
      this.view.destroy()
      this.view = null
    }
    this.update()
    this.host.requestFrame()
    return show
  }

  recent(): FrameSample[] {
    const out: FrameSample[] = []
    for (let i = 0; i < RING; i++) {
      const s = this.ring[(this.head + i) % RING]
      if (s) {
        out.push(s)
      }
    }
    return out
  }

  /** A frame finished (the compositor calls this while active). */
  push(s: FrameSample, why?: FrameWhyInput): void {
    if (this.traceOn) {
      const { events, more } = this.trace.take()
      const scopes: number[] = []
      if (why) {
        for (const el of why.scopes) {
          if (scopes.length >= MAX_SCOPES) {
            break
          }
          scopes.push(this.registry.id(el))
        }
      }
      s.why = {
        events,
        more,
        scopes,
        scopeCount: why?.scopeCount ?? 0,
        alive: why?.alive ?? []
      }
    }
    this.ring[this.head] = s
    this.head = (this.head + 1) % RING
    this.session?.push(s)
    if (this.flying) {
      this.flightFrames.push(s)
      this.trim(s.t)
    } else if (!this.session && this.longFrames.length > 0) {
      // Tracks alone: long frames only for the queued hitches.
      const keep = s.t - 5000
      this.longFrames = this.longFrames.filter((f) => f.at + f.duration >= keep)
    }
    if (this.devtools) {
      this.trackFrame(s)
    }
    this.view?.draw(this.recent(), this.opts.refreshMs)
  }

  /** Write `s` to the DevTools tracks; late frames' markers wait half a
   * second for their long animation frames. */
  private trackFrame(s: FrameSample): void {
    const d = this.devtools
    if (!d) {
      return
    }
    if (s.t - this.trackRefreshAt > 1000) {
      this.trackRefreshAt = s.t
      this.trackRefresh = this.opts.refreshMs ?? estimateRefresh(this.recent())
    }
    const late = missed(s, this.trackRefresh) > 0
    d.frame(s, late)
    if (late) {
      this.lateQueue.push({ s, at: s.t })
    }
    while (
      this.lateQueue.length > 0 &&
      s.t - (this.lateQueue[0]?.at ?? 0) > 500
    ) {
      const q = this.lateQueue.shift()
      if (!q) {
        break
      }
      const frames = this.recent()
      const i = frames.indexOf(q.s)
      if (i > 0) {
        d.hitch(
          q.s,
          hitchAt(
            frames,
            i,
            this.trackRefresh,
            0,
            this.longFrames,
            (k) => this.registry.paths[k]
          )
        )
      }
    }
  }

  destroy(): void {
    this.session = null
    this.devtools = null
    this.flightMs = 0
    this.flightFrames = []
    this.view?.destroy()
    this.view = null
    this.update()
  }

  /** Drop flight frames, long frames and marks older than the window
   * (unless a recording still needs them). */
  private trim(now: number): void {
    const from = now - this.flightMs
    let k = 0
    while (
      k < this.flightFrames.length &&
      (this.flightFrames[k]?.t ?? 0) < from
    ) {
      k++
    }
    if (k > 0) {
      this.flightFrames.splice(0, k)
    }
    const keep = this.session ? Math.min(from, this.startedAt) : from
    if (
      (this.longFrames[0]?.at ?? Infinity) +
        (this.longFrames[0]?.duration ?? 0) <
      keep
    ) {
      this.longFrames = this.longFrames.filter((f) => f.at + f.duration >= keep)
    }
    if ((this.marks[0]?.at ?? Infinity) < keep) {
      // The last mark before the window labels its start.
      const before = this.marks.filter((m) => m.at < keep)
      this.marks = [
        ...before.slice(-1),
        ...this.marks.filter((m) => m.at >= keep)
      ]
    }
  }

  private async gpuSettled(): Promise<void> {
    const until = performance.now() + 300
    while (this.host.gpuTimingPending() > 0 && performance.now() < until) {
      await new Promise((r) => setTimeout(r, 16))
    }
  }

  private update(): void {
    const sampling =
      this.session !== null || this.flying || this.devtools !== null
    this.active = sampling || this.view !== null
    const gpu = this.active && this.opts.gpu !== false
    if (gpu !== this.gpuOn) {
      this.gpuOn = gpu
      this.host.setGpuTiming(gpu ? (t) => this.attachGpu(t) : null)
    }
    if (sampling !== this.traceOn) {
      this.traceOn = sampling
      this.trace.clear()
      this.host.setTrace?.(
        sampling ? (k, n, d) => this.trace.note(k, n, d) : null
      )
    }
    if (sampling && !this.observer) {
      this.observeLongFrames()
    } else if (!sampling && this.observer) {
      this.observer.disconnect()
      this.observer = null
    }
  }

  private attachGpu(t: GpuFrameTiming): void {
    for (let i = 1; i <= RING; i++) {
      const s = this.ring[(this.head - i + RING) % RING]
      if (!s || s.id < t.frame) {
        return
      }
      if (s.id === t.frame) {
        s.gpu = t
        this.devtools?.gpu(s)
        return
      }
    }
  }

  private observeLongFrames(): void {
    if (
      typeof PerformanceObserver === 'undefined' ||
      !PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')
    ) {
      return
    }
    this.observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        // Absolute times; report() makes them relative.
        this.longFrames.push(longFrame(e as LoafEntry, 0))
      }
    })
    this.observer.observe({ type: 'long-animation-frame', buffered: false })
  }

  /** A report over `frames`, times relative to `origin` (absolute). */
  private report(frames: FrameSample[], origin: number): ProfileReport {
    const refresh = this.opts.refreshMs ?? estimateRefresh(frames)
    const last = frames[frames.length - 1]
    const end = (last?.t ?? origin) + 1
    const longFrames = this.longFrames
      .filter((f) => f.at + f.duration >= origin && f.at <= end)
      .map((f) => ({
        ...f,
        at: f.at - origin,
        scripts: f.scripts.map((x) =>
          x.at !== undefined ? { ...x, at: x.at - origin } : x
        )
      }))
    const inWindow = this.marks.filter((m) => m.at <= end)
    // The last mark before the start labels the first phase.
    const lead = inWindow.filter((m) => m.at < origin).slice(-1)
    const marks = [...lead, ...inWindow.filter((m) => m.at >= origin)].map(
      (m) => ({ at: Math.max(0, m.at - origin), label: m.label })
    )
    const paths = (i: number): string | undefined => this.registry.paths[i]
    const phases: ProfileReport['phases'] = []
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i]
      const next = marks[i + 1]
      if (!m) {
        continue
      }
      const part = frames.filter(
        (s) => s.t - origin >= m.at && (!next || s.t - origin < next.at)
      )
      phases.push({
        label: m.label,
        summary: summarize(part, refresh, origin, longFrames, paths)
      })
    }
    const summary = summarize(frames, refresh, origin, longFrames, paths)
    // The elements the samples and hitches name.
    const elements: Record<number, string> = {}
    const use = (i: number | undefined): void => {
      const p = i === undefined ? undefined : this.registry.paths[i]
      if (i !== undefined && p !== undefined) {
        elements[i] = p
      }
    }
    for (const s of frames) {
      for (const e of s.why?.events ?? []) {
        use(e.el)
      }
      for (const i of s.why?.scopes ?? []) {
        use(i)
      }
    }
    const d = this.host.describe?.() ?? {}
    return {
      ...summary,
      gpuTiming: frames.some((s) => s.gpu !== null),
      phases,
      marks,
      longFrames,
      samples: frames,
      env: {
        dpr: window.devicePixelRatio,
        width: window.innerWidth,
        height: window.innerHeight,
        userAgent: navigator.userAgent,
        url: location.href,
        ...d
      },
      elements,
      origin
    }
  }
}

interface LoafScript {
  invoker?: string
  invokerType?: string
  sourceURL?: string
  sourceFunctionName?: string
  sourceCharPosition?: number
  startTime?: number
  forcedStyleAndLayoutDuration?: number
  duration: number
}
interface LoafEntry extends PerformanceEntry {
  blockingDuration?: number
  renderStart?: number
  styleAndLayoutStart?: number
  scripts?: LoafScript[]
}

function longFrame(e: LoafEntry, origin: number): LongFrame {
  const end = e.startTime + e.duration
  const scripts = [...(e.scripts ?? [])]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5)
    .map((s): LongFrameScript => {
      const url = (s.sourceURL ?? '').split(/[?#]/)[0] ?? ''
      const src = url.split('/').pop() ?? ''
      const fn = s.sourceFunctionName || ''
      const out: LongFrameScript = {
        name: `${s.invoker || s.invokerType || 'script'}${fn ? ` ${fn}` : ''}${src ? ` (${src})` : ''}`,
        ms: s.duration
      }
      if (s.startTime !== undefined) {
        out.at = s.startTime - origin
      }
      if (url) {
        out.source =
          s.sourceCharPosition !== undefined && s.sourceCharPosition >= 0
            ? `${url}:${s.sourceCharPosition}`
            : url
      }
      if (s.invokerType) {
        out.type = s.invokerType
      }
      if (s.forcedStyleAndLayoutDuration) {
        out.forced = s.forcedStyleAndLayoutDuration
      }
      return out
    })
  return {
    at: e.startTime - origin,
    duration: e.duration,
    blocking: e.blockingDuration ?? 0,
    layout: e.styleAndLayoutStart ? end - e.styleAndLayoutStart : 0,
    render: e.renderStart ? end - e.renderStart : 0,
    scripts
  }
}

/** Nearest-rank percentiles. */
export function pct(xs: number[]): Pct {
  const n = xs.length
  if (n === 0) {
    return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 }
  }
  const s = [...xs].sort((a, b) => a - b)
  const at = (q: number): number =>
    s[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))] ?? 0
  let sum = 0
  for (const x of s) {
    sum += x
  }
  return {
    n,
    mean: sum / n,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: s[n - 1] ?? 0
  }
}

/** `s.dt` measures frame pacing: the frame was asked for during or
 * within a refresh interval of the previous one. */
export function paced(s: FrameSample, refresh: number): boolean {
  return s.continuous || s.requested < refresh
}

/** Refresh intervals `s` missed (0 when on time): by its interval when
 * paced, otherwise by its wait since the request. */
export function missed(s: FrameSample, refresh: number): number {
  const over = paced(s, refresh) ? s.dt : s.wait
  return over > refresh * 1.5 ? Math.max(1, Math.round(over / refresh) - 1) : 0
}

/** The refresh interval: the lower quartile of paced frame gaps, snapped
 * to a common rate when within 8%. */
export function estimateRefresh(samples: FrameSample[]): number {
  const dts = samples
    .filter((s) => (s.continuous || s.requested < 20) && s.dt > 0)
    .map((s) => s.dt)
  if (dts.length < 4) {
    return 1000 / 60
  }
  const q = pct(dts)
  const s = [...dts].sort((a, b) => a - b)
  const est = s[Math.floor(s.length * 0.25)] ?? q.p50
  for (const r of COMMON_REFRESH) {
    if (Math.abs(est - r) / r < 0.08) {
      return r
    }
  }
  return est
}

/** Per label, the ms of the frame during which one of its spans ran and
 * no other label's did. */
function aloneTimes(spans: readonly GpuSpan[]): Map<string, number> {
  const edges: [number, number, string][] = []
  for (const sp of spans) {
    if (sp.ms > 0) {
      edges.push([sp.start, 1, sp.label], [sp.start + sp.ms, -1, sp.label])
    }
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const open = new Map<string, number>()
  const out = new Map<string, number>()
  for (const sp of spans) {
    out.set(sp.label, 0)
  }
  let prev = 0
  for (const [t, d, label] of edges) {
    if (open.size === 1) {
      const [only] = open.keys()
      if (only !== undefined) {
        out.set(only, (out.get(only) ?? 0) + (t - prev))
      }
    }
    const n = (open.get(label) ?? 0) + d
    if (n > 0) {
      open.set(label, n)
    } else {
      open.delete(label)
    }
    prev = t
  }
  return out
}

/** The hitch at late frame `samples[i]` (any frame: one on time gets
 * missed 0): the gap before it and what contributed. */
export function hitchAt(
  samples: readonly FrameSample[],
  i: number,
  refresh: number,
  origin = 0,
  longFrames: readonly LongFrame[] = [],
  path?: (i: number) => string | undefined
): Hitch {
  const s = samples[i] as FrameSample
  const isPaced = paced(s, refresh)
  const prev = samples[i - 1] ?? null
  const before = isPaced ? prev : null
  const gap = isPaced ? s.dt : s.wait
  const factors = explain({
    before,
    prev,
    late: s,
    from: s.t - gap,
    to: s.t,
    refresh,
    origin,
    longFrames,
    path
  })
  return {
    at: s.t - origin,
    dt: gap,
    missed: missed(s, refresh),
    cause: causeOf(factors[0]?.kind),
    detail: factorsText(factors),
    factors,
    before
  }
}

export function summarize(
  samples: FrameSample[],
  refresh: number,
  origin = 0,
  longFrames: LongFrame[] = [],
  path?: (i: number) => string | undefined
): ProfileSummary {
  const cont = samples.filter((s) => paced(s, refresh))
  const keys: (keyof CpuBreakdown)[] = [
    'total',
    'read',
    'hooks',
    'upload',
    'encode',
    'cull',
    'scene',
    'batches',
    'text',
    'other'
  ]
  const cpu = {} as Record<keyof CpuBreakdown, Pct>
  for (const k of keys) {
    cpu[k] = pct(samples.map((s) => s.cpu[k]))
  }
  const timed = samples.filter((s) => s.gpu)
  let gpu: ProfileSummary['gpu'] = null
  if (timed.length > 0) {
    const byLabel = new Map<string, number[]>()
    for (const s of timed) {
      const sums = new Map<string, number>()
      for (const sp of s.gpu?.spans ?? []) {
        sums.set(sp.label, (sums.get(sp.label) ?? 0) + sp.ms)
      }
      for (const [l, ms] of sums) {
        let a = byLabel.get(l)
        if (!a) {
          a = []
          byLabel.set(l, a)
        }
        a.push(ms)
      }
    }
    const passes: Record<string, Pct> = {}
    for (const [l, a] of byLabel) {
      passes[l] = pct(a)
    }
    // Per label, the time its passes ran with no other label's pass
    // running (passes overlap on the GPU, so the sums above can add up to
    // more than the frame).
    const aloneBy = new Map<string, number[]>()
    for (const s of timed) {
      for (const [l, ms] of aloneTimes(s.gpu?.spans ?? [])) {
        let a = aloneBy.get(l)
        if (!a) {
          a = []
          aloneBy.set(l, a)
        }
        a.push(ms)
      }
    }
    const alone: Record<string, Pct> = {}
    for (const [l, a] of aloneBy) {
      alone[l] = pct(a)
    }
    gpu = {
      total: pct(timed.map((s) => s.gpu?.totalMs ?? 0)),
      passes,
      alone
    }
  }
  const reads = {
    none: 0,
    full: 0,
    partial: 0,
    escalated: 0,
    causes: {} as Record<string, number>,
    elements: pct([])
  }
  const els: number[] = []
  for (const s of samples) {
    reads[s.read]++
    if (s.read !== 'none') {
      els.push(s.readElements)
    }
    if (s.read === 'full' || s.read === 'escalated') {
      const key = `${s.read}: ${s.cause}`
      reads.causes[key] = (reads.causes[key] ?? 0) + 1
    }
  }
  reads.elements = pct(els)

  let late = 0
  let dropped = 0
  const hitches: Hitch[] = []
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    const m = s ? missed(s, refresh) : 0
    if (!s || m === 0) {
      continue
    }
    late++
    dropped += m
    hitches.push(hitchAt(samples, i, refresh, origin, longFrames, path))
  }
  hitches.sort((a, b) => b.dt - a.dt)
  const first = samples[0]
  const last = samples[samples.length - 1]
  return {
    frames: samples.length,
    durationMs: first && last ? last.t - first.t : 0,
    refreshMs: refresh,
    dt: pct(cont.map((s) => s.dt)),
    late,
    dropped,
    skipped: samples.filter((s) => s.skipped).length,
    cpu,
    gpu,
    reads,
    hitches: hitches.slice(0, 12)
  }
}

/** A report as text (the harness prints this). */
export function formatReport(r: ProfileSummary, title = 'profile'): string {
  const f = (v: number): string => ` ${v.toFixed(2).padStart(7)}`
  const row = (label: string, p: Pct): string =>
    `  ${label.padEnd(18)}${f(p.p50)}${f(p.p95)}${f(p.p99)}${f(p.max)}`
  // Rows added later than a saved report: zero.
  const none: Pct = { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 }
  const lines = [
    `${title}: ${r.frames} frames over ${(r.durationMs / 1000).toFixed(1)} s, refresh ${r.refreshMs.toFixed(2)} ms (${(1000 / r.refreshMs).toFixed(0)} Hz)`,
    `  late ${r.late}, dropped ${r.dropped}; skipped ${r.skipped ?? 0}; reads: ${r.reads.partial} partial, ${r.reads.full} full, ${r.reads.escalated} escalated`,
    `  ${''.padEnd(18)}     p50     p95     p99     max`,
    row('frame interval', r.dt),
    row('cpu total', r.cpu.total),
    row('  read', r.cpu.read),
    row('    scene', r.cpu.scene ?? none),
    row('      batches', r.cpu.batches ?? none),
    row('  hooks', r.cpu.hooks),
    row('  upload', r.cpu.upload),
    row('    text', r.cpu.text ?? none),
    row('  encode', r.cpu.encode),
    row('    cull', r.cpu.cull ?? none),
    row('  other', r.cpu.other)
  ]
  if (r.gpu) {
    lines.push(row('gpu total', r.gpu.total))
    const passes = Object.entries(r.gpu.passes).sort(
      (a, b) => b[1].p95 - a[1].p95
    )
    for (const [l, p] of passes.slice(0, 8)) {
      lines.push(row(`  ${l}`, p))
      const a = r.gpu.alone?.[l]
      if (a) {
        lines.push(row('    alone', a))
      }
    }
  }
  const causes = Object.entries(r.reads.causes).sort((a, b) => b[1] - a[1])
  for (const [c, n] of causes.slice(0, 5)) {
    lines.push(`  ${String(n).padStart(4)}× ${c}`)
  }
  for (const h of r.hitches.slice(0, 5)) {
    lines.push(
      `  hitch +${(h.at / 1000).toFixed(2)} s: ${h.dt.toFixed(1)} ms (${h.missed} missed), ${h.cause}: ${h.detail}`
    )
  }
  return lines.join('\n')
}
