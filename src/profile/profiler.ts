// The frame profiler (compositor.profile): a sample per compositor frame
// with its CPU breakdown, what the DOM read did and why, and the GPU pass
// timings when the device has timestamp-query. Recording collects a
// session and reports percentiles, dropped frames and the likely cause of
// each hitch; the HUD (profile/hud.ts) draws the most recent frames live.
// Nothing is sampled while neither is on.

import type { GpuFrameTiming } from '../gpu/timer'
import type { Layer } from '../types'
import { Hud } from './hud'

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
  /** The rest: dirty tracking, canvas placement, bookkeeping. */
  other: number
}

export interface FrameSample {
  /** Renderer frame number (GpuFrameTiming.frame). */
  id: number
  /** rAF timestamp, ms. */
  t: number
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
  /** Filled in a frame or two later; null without timestamp-query. */
  gpu: GpuFrameTiming | null
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
  /** 'compositor cpu', 'gpu', 'script', 'outside' (layout, paint, GC or
   * script the browser didn't attribute). */
  cause: 'compositor cpu' | 'gpu' | 'script' | 'outside'
  detail: string
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
  /** The longest scripts: invoker and source, ms. */
  scripts: { name: string; ms: number }[]
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
  cpu: Record<keyof CpuBreakdown, Pct>
  /** GPU frame time and per pass label (summed per frame); null without
   * timestamp-query. */
  gpu: { total: Pct; passes: Record<string, Pct> } | null
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
  env: { dpr: number; width: number; height: number; userAgent: string }
}

/** The compositor side the profiler drives. */
export interface ProfileHost {
  setGpuTiming(onResult: ((t: GpuFrameTiming) => void) | null): boolean
  gpuTimingPending(): number
  requestFrame(): void
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
  /** Sampling is on (a recording or the HUD). */
  active = false
  private readonly ring: (FrameSample | null)[] = new Array(RING).fill(null)
  private head = 0
  private session: FrameSample[] | null = null
  private opts: ProfileOptions = {}
  private startedAt = 0
  private marks: { at: number; label: string }[] = []
  private longFrames: LongFrame[] = []
  private observer: PerformanceObserver | null = null
  private view: Hud | null = null
  private gpuOn = false

  constructor(private readonly host: ProfileHost) {}

  get recording(): boolean {
    return this.session !== null
  }

  start(opts: ProfileOptions = {}): void {
    this.opts = opts
    this.session = []
    this.marks = []
    this.longFrames = []
    this.startedAt = performance.now()
    this.observeLongFrames()
    this.update()
  }

  async stop(): Promise<ProfileReport | null> {
    const session = this.session
    if (!session) {
      return null
    }
    const until = performance.now() + 300
    while (this.host.gpuTimingPending() > 0 && performance.now() < until) {
      await new Promise((r) => setTimeout(r, 16))
    }
    this.session = null
    this.observer?.disconnect()
    this.observer = null
    const report = this.report(session)
    this.update()
    return report
  }

  mark(label: string): void {
    if (this.session) {
      this.marks.push({ at: performance.now() - this.startedAt, label })
    }
  }

  hud(on?: boolean): boolean {
    const show = on ?? !this.view
    if (show && !this.view) {
      this.view = new Hud()
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
  push(s: FrameSample): void {
    this.ring[this.head] = s
    this.head = (this.head + 1) % RING
    this.session?.push(s)
    this.view?.draw(this.recent(), this.opts.refreshMs)
  }

  destroy(): void {
    this.session = null
    this.observer?.disconnect()
    this.view?.destroy()
    this.view = null
    this.update()
  }

  private update(): void {
    this.active = this.session !== null || this.view !== null
    const gpu = this.active && this.opts.gpu !== false
    if (gpu !== this.gpuOn) {
      this.gpuOn = gpu
      this.host.setGpuTiming(gpu ? (t) => this.attachGpu(t) : null)
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
        return
      }
    }
  }

  private observeLongFrames(): void {
    this.observer?.disconnect()
    this.observer = null
    if (
      typeof PerformanceObserver === 'undefined' ||
      !PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')
    ) {
      return
    }
    this.observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        this.longFrames.push(longFrame(e as LoafEntry, this.startedAt))
      }
    })
    this.observer.observe({ type: 'long-animation-frame', buffered: false })
  }

  private report(session: FrameSample[]): ProfileReport {
    const refresh = this.opts.refreshMs ?? estimateRefresh(session)
    const rel = (s: FrameSample): number => s.t - this.startedAt
    const phases: ProfileReport['phases'] = []
    for (let i = 0; i < this.marks.length; i++) {
      const m = this.marks[i]
      const next = this.marks[i + 1]
      if (!m) {
        continue
      }
      const part = session.filter(
        (s) => rel(s) >= m.at && (!next || rel(s) < next.at)
      )
      phases.push({
        label: m.label,
        summary: summarize(part, refresh, this.startedAt, this.longFrames)
      })
    }
    return {
      ...summarize(session, refresh, this.startedAt, this.longFrames),
      gpuTiming: session.some((s) => s.gpu !== null),
      phases,
      marks: this.marks,
      longFrames: this.longFrames,
      samples: session,
      env: {
        dpr: window.devicePixelRatio,
        width: window.innerWidth,
        height: window.innerHeight,
        userAgent: navigator.userAgent
      }
    }
  }
}

interface LoafScript {
  invoker?: string
  invokerType?: string
  sourceURL?: string
  sourceFunctionName?: string
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
    .slice(0, 3)
    .map((s) => {
      const src = (s.sourceURL ?? '').split(/[?#]/)[0]?.split('/').pop() ?? ''
      const fn = s.sourceFunctionName || ''
      return {
        name: `${s.invoker || s.invokerType || 'script'}${fn ? ` ${fn}` : ''}${src ? ` (${src})` : ''}`,
        ms: s.duration
      }
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

export function summarize(
  samples: FrameSample[],
  refresh: number,
  origin = 0,
  longFrames: LongFrame[] = []
): ProfileSummary {
  const cont = samples.filter((s) => paced(s, refresh))
  const keys: (keyof CpuBreakdown)[] = [
    'total',
    'read',
    'hooks',
    'upload',
    'encode',
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
    gpu = { total: pct(timed.map((s) => s.gpu?.totalMs ?? 0)), passes }
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
    const isPaced = paced(s, refresh)
    const prev = samples[i - 1] ?? null
    const before = isPaced ? prev : null
    const gap = isPaced ? s.dt : s.wait
    hitches.push({
      at: s.t - origin,
      dt: gap,
      missed: m,
      ...blame(before, prev, s.t - gap, s.t, refresh, origin, longFrames),
      before
    })
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
    cpu,
    gpu,
    reads,
    hitches: hitches.slice(0, 12)
  }
}

/** `before`: the frame whose CPU work preceded the gap (paced frames);
 * `prev`: the previous frame, whose GPU work may still run into it. */
function blame(
  before: FrameSample | null,
  prev: FrameSample | null,
  gapFrom: number,
  gapTo: number,
  refresh: number,
  origin: number,
  longFrames: LongFrame[]
): Pick<Hitch, 'cause' | 'detail'> {
  const ms = (v: number): string => `${v.toFixed(1)} ms`
  if (before && before.cpu.total > refresh * 0.6) {
    const c = before.cpu
    const parts: [string, number][] = [
      [
        `read ${before.read}${before.cause ? ` (${before.cause})` : ''}, ${before.readElements} elements`,
        c.read
      ],
      ['hooks', c.hooks],
      [`upload ${Object.keys(before.uploads).join('/')}`, c.upload],
      ['encode', c.encode],
      ['other', c.other]
    ]
    parts.sort((a, b) => b[1] - a[1])
    const top = parts[0]
    return {
      cause: 'compositor cpu',
      detail: `${ms(c.total)} in the frame before; most in ${top?.[0]} ${ms(top?.[1] ?? 0)}`
    }
  }
  const gpu = prev?.gpu
  if (
    prev &&
    gpu &&
    gpu.totalMs > refresh * 0.8 &&
    prev.t + gpu.totalMs > gapFrom
  ) {
    const top = [...gpu.spans].sort((a, b) => b.ms - a.ms).slice(0, 3)
    return {
      cause: 'gpu',
      detail: `${ms(gpu.totalMs)} on the GPU in the frame before; ${top.map((p) => `${p.label} ${ms(p.ms)}`).join(', ')}`
    }
  }
  const from = gapFrom - origin
  const to = gapTo - origin
  const lf = longFrames.find((f) => f.at + f.duration > from && f.at < to)
  if (lf) {
    const script = lf.scripts[0]
    if (script && script.ms > refresh * 0.5) {
      return {
        cause: 'script',
        detail: `long frame ${ms(lf.duration)}: ${lf.scripts.map((x) => `${x.name} ${ms(x.ms)}`).join(', ')}`
      }
    }
    return {
      cause: 'outside',
      detail: `long frame ${ms(lf.duration)}: style/layout ${ms(lf.layout)}, render ${ms(lf.render)}`
    }
  }
  return {
    cause: 'outside',
    detail: 'not in the compositor (layout, paint, GC or other script)'
  }
}

/** A report as text (the harness prints this). */
export function formatReport(r: ProfileSummary, title = 'profile'): string {
  const f = (v: number): string => ` ${v.toFixed(2).padStart(7)}`
  const row = (label: string, p: Pct): string =>
    `  ${label.padEnd(18)}${f(p.p50)}${f(p.p95)}${f(p.p99)}${f(p.max)}`
  const lines = [
    `${title}: ${r.frames} frames over ${(r.durationMs / 1000).toFixed(1)} s, refresh ${r.refreshMs.toFixed(2)} ms (${(1000 / r.refreshMs).toFixed(0)} Hz)`,
    `  late ${r.late}, dropped ${r.dropped}; reads: ${r.reads.partial} partial, ${r.reads.full} full, ${r.reads.escalated} escalated`,
    `  ${''.padEnd(18)}     p50     p95     p99     max`,
    row('frame interval', r.dt),
    row('cpu total', r.cpu.total),
    row('  read', r.cpu.read),
    row('  hooks', r.cpu.hooks),
    row('  upload', r.cpu.upload),
    row('  encode', r.cpu.encode),
    row('  other', r.cpu.other)
  ]
  if (r.gpu) {
    lines.push(row('gpu total', r.gpu.total))
    const passes = Object.entries(r.gpu.passes).sort(
      (a, b) => b[1].p95 - a[1].p95
    )
    for (const [l, p] of passes.slice(0, 8)) {
      lines.push(row(`  ${l}`, p))
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
