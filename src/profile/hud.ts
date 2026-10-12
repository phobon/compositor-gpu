// The live HUD (compositor.profile.hud()): a fixed 2D canvas in the
// bottom-left corner drawing the most recent frames. Each column is a
// frame: CPU time stacked by phase (read, hooks, upload, encode, other),
// GPU time as a line, and the frame interval behind them, red when the
// frame came late. The dashed line is the refresh budget. It sits outside
// the mirrored root, above the compositor canvas, and is never mirrored.
//
// Above the graph, over the frames shown:
//   1. refresh, CPU and GPU ms per frame (p50/p95), late frames
//   2. GPU ms per pass label (p50), costliest first
//   3. frames that reused the scene, draws (p50), reads by kind, and
//      whether scene reuse is on
//   4. the last frame's read, and the baseline's state
// Keys while it shows: B freezes the current numbers as a baseline (each
// number then shows its change against it, green better, red worse),
// Shift+B clears it, R switches scene reuse (Compositor.sceneReuse) and
// restarts the window the text counts.

import {
  estimateRefresh,
  type FrameSample,
  missed,
  type ProfileHost,
  paced,
  pct
} from './profiler'

const W = 400
const LINE = 13
const GRAPH_TOP = 4 * LINE + 8
const H = GRAPH_TOP + 98
const COL = 2
const COLORS = {
  read: '#f59e0b',
  hooks: '#a78bfa',
  upload: '#38bdf8',
  encode: '#34d399',
  other: '#9ca3af',
  gpu: '#ffffff',
  late: 'rgba(239, 68, 68, 0.55)',
  dt: 'rgba(255, 255, 255, 0.08)'
} as const
const TEXT = '#e5e7eb'
const DIM = '#9ca3af'
const BETTER = '#34d399'
const WORSE = '#f87171'

/** The numbers the text lines show, over a window of frames. */
interface Stats {
  hz: number
  frames: number
  cpu50: number
  cpu95: number
  gpu50: number | null
  gpu95: number | null
  late: number
  /** p50 GPU ms per pass label (frames where it ran), costliest first. */
  passes: [string, number][]
  /** Share of frames that reused the scene, 0..1. */
  reuse: number
  draws: number
  reads: { none: number; partial: number; full: number }
}

function stats(frames: FrameSample[], refresh: number): Stats {
  const cpu = pct(frames.map((s) => s.cpu.total))
  const timed = frames.filter((s) => s.gpu)
  const gpu = timed.length ? pct(timed.map((s) => s.gpu?.totalMs ?? 0)) : null
  const byLabel = new Map<string, number[]>()
  for (const s of timed) {
    const sum = new Map<string, number>()
    for (const span of s.gpu?.spans ?? []) {
      sum.set(span.label, (sum.get(span.label) ?? 0) + span.ms)
    }
    for (const [label, ms] of sum) {
      let a = byLabel.get(label)
      if (!a) {
        a = []
        byLabel.set(label, a)
      }
      a.push(ms)
    }
  }
  const passes = [...byLabel]
    .map(([label, a]): [string, number] => [label, pct(a).p50])
    .sort((a, b) => b[1] - a[1])
  const reads = { none: 0, partial: 0, full: 0 }
  for (const s of frames) {
    if (s.read === 'none') {
      reads.none++
    } else if (s.read === 'partial') {
      reads.partial++
    } else {
      reads.full++
    }
  }
  return {
    hz: 1000 / refresh,
    frames: frames.length,
    cpu50: cpu.p50,
    cpu95: cpu.p95,
    gpu50: gpu?.p50 ?? null,
    gpu95: gpu?.p95 ?? null,
    late: frames.filter((s) => missed(s, refresh) > 0).length,
    passes,
    reuse: frames.length
      ? frames.filter((s) => s.reused).length / frames.length
      : 0,
    draws: pct(frames.map((s) => s.draws)).p50,
    reads
  }
}

/** A run of text in one colour. */
type Run = [string, string]

/** ` +0.4` / ` -0.4` against the baseline: green when it improved
 * (`lowerBetter`: it went down), red when it got worse, nothing when it
 * barely moved. */
function delta(
  now: number | null,
  then: number | null | undefined,
  lowerBetter = true,
  eps = 0.05,
  digits = 1
): Run[] {
  if (now === null || then === null || then === undefined) {
    return []
  }
  const d = now - then
  if (Math.abs(d) < eps) {
    return [[' ±0', DIM]]
  }
  const better = lowerBetter ? d < 0 : d > 0
  const sign = d > 0 ? '+' : '-'
  return [[` ${sign}${Math.abs(d).toFixed(digits)}`, better ? BETTER : WORSE]]
}

export class Hud {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private lines: Run[][] = []
  private textAt = 0
  private current: Stats | null = null
  private baseline: Stats | null = null
  private baselineAt = 0
  /** The text counts only frames from here on (set when R switches
   * reuse, so the numbers aren't a mix of both modes). */
  private since = 0

  constructor(private readonly host: ProfileHost) {
    const c = document.createElement('canvas')
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(W * dpr)
    c.height = Math.round(H * dpr)
    c.setAttribute('data-gpu-ignore', '')
    c.setAttribute('aria-hidden', 'true')
    Object.assign(c.style, {
      position: 'fixed',
      left: '8px',
      bottom: '8px',
      width: `${W}px`,
      height: `${H}px`,
      zIndex: '2147483647',
      pointerEvents: 'none',
      borderRadius: '6px'
    } satisfies Partial<CSSStyleDeclaration>)
    document.documentElement.appendChild(c)
    this.canvas = c
    this.ctx = c.getContext('2d')
    this.ctx?.scale(dpr, dpr)
    window.addEventListener('keydown', this.onKey)
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) {
      return
    }
    const t = e.target
    if (
      t instanceof HTMLElement &&
      (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
    ) {
      return
    }
    const key = e.key.toLowerCase()
    if (key === 'b') {
      if (e.shiftKey) {
        this.baseline = null
      } else if (this.current) {
        this.baseline = this.current
        this.baselineAt = performance.now()
      }
      this.textAt = 0
      this.host.requestFrame()
    } else if (key === 'r') {
      this.host.setSceneReuse(!this.host.sceneReuse())
      this.since = performance.now()
      this.textAt = 0
    }
  }

  draw(frames: FrameSample[], refreshMs?: number): void {
    const g = this.ctx
    if (!g) {
      return
    }
    const refresh = refreshMs ?? estimateRefresh(frames)
    const scale = (GRAPH_TOP - H + 6) / (refresh * 2)
    const base = H - 6
    const y = (ms: number): number => base + Math.min(ms, refresh * 2) * scale
    g.clearRect(0, 0, W, H)
    g.fillStyle = 'rgba(17, 17, 20, 0.82)'
    g.fillRect(0, 0, W, H)

    const n = Math.floor((W - 8) / COL)
    const shown = frames.slice(-n)
    let x = W - 4 - shown.length * COL
    for (const s of shown) {
      if (paced(s, refresh)) {
        g.fillStyle = missed(s, refresh) > 0 ? COLORS.late : COLORS.dt
        g.fillRect(x, y(s.dt), COL, base - y(s.dt))
      }
      let top = base
      for (const k of ['read', 'hooks', 'upload', 'encode', 'other'] as const) {
        const v = s.cpu[k]
        if (v <= 0) {
          continue
        }
        const h = Math.max(0.5, -v * scale)
        g.fillStyle = COLORS[k]
        g.fillRect(x, top - h, COL, h)
        top -= h
      }
      x += COL
    }
    g.strokeStyle = COLORS.gpu
    g.lineWidth = 1
    g.beginPath()
    x = W - 4 - shown.length * COL
    let pen = false
    for (const s of shown) {
      if (s.gpu) {
        const py = y(s.gpu.totalMs)
        if (pen) {
          g.lineTo(x + COL / 2, py)
        } else {
          g.moveTo(x + COL / 2, py)
          pen = true
        }
      }
      x += COL
    }
    g.stroke()
    g.setLineDash([3, 3])
    g.strokeStyle = 'rgba(255, 255, 255, 0.45)'
    g.beginPath()
    g.moveTo(4, y(refresh) + 0.5)
    g.lineTo(W - 4, y(refresh) + 0.5)
    g.stroke()
    g.setLineDash([])

    // The text refreshes four times a second (cheaper, and readable).
    const now = performance.now()
    if (now - this.textAt > 250) {
      this.textAt = now
      const counted = frames.filter((f) => f.t >= this.since)
      this.current = stats(counted.length > 0 ? counted : frames, refresh)
      this.lines = this.textLines(this.current, frames[frames.length - 1])
    }
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
    this.lines.forEach((runs, i) => {
      let tx = 6
      for (const [text, color] of runs) {
        g.fillStyle = color
        g.fillText(text, tx, 13 + i * LINE)
        tx += g.measureText(text).width
      }
    })
  }

  private textLines(s: Stats, last: FrameSample | undefined): Run[][] {
    const b = this.baseline
    const f = (v: number): string => v.toFixed(1)
    const l1: Run[] = [
      [`${s.hz.toFixed(0)}Hz cpu ${f(s.cpu50)}/${f(s.cpu95)}`, TEXT],
      ...delta(s.cpu50, b?.cpu50)
    ]
    if (s.gpu50 !== null && s.gpu95 !== null) {
      l1.push(
        [` gpu ${f(s.gpu50)}/${f(s.gpu95)}`, TEXT],
        ...delta(s.gpu50, b?.gpu50),
        ...(b ? [['/', DIM] as Run] : []),
        ...delta(s.gpu95, b?.gpu95).map(([t, c]): Run => [t.trimStart(), c])
      )
    }
    l1.push([` late ${s.late}/${s.frames}`, TEXT])
    const l2: Run[] = [['gpu passes', DIM]]
    if (s.passes.length === 0) {
      l2.push([' (no timestamp-query)', DIM])
    }
    for (const [label, ms] of s.passes.slice(0, 4)) {
      const was = b?.passes.find(([l]) => l === label)?.[1]
      l2.push([` ${label} ${f(ms)}`, TEXT], ...delta(ms, b ? (was ?? 0) : null))
    }
    const reuseOn = this.host.sceneReuse()
    const l3: Run[] = [
      [`reuse ${(s.reuse * 100).toFixed(0)}%`, TEXT],
      ...delta(s.reuse * 100, b ? b.reuse * 100 : null, false, 2, 0),
      [` draws ${s.draws.toFixed(0)}`, TEXT],
      ...delta(s.draws, b?.draws, true, 0.5, 0),
      [` reads -${s.reads.none} p${s.reads.partial} f${s.reads.full}`, TEXT],
      [` [R] reuse ${reuseOn ? 'on' : 'off'}`, reuseOn ? DIM : WORSE]
    ]
    const read = last
      ? last.read === 'none'
        ? 'no read'
        : `${last.read} read ${last.readElements} el${last.cause ? ` · ${last.cause}` : ''}`
      : ''
    const base = b
      ? `  [B] vs baseline ${((performance.now() - this.baselineAt) / 1000).toFixed(0)}s ago, ⇧B clears`
      : '  [B] set baseline'
    const l4: Run[] = [
      [read.slice(0, Math.max(0, 58 - base.length)), DIM],
      [base, b ? TEXT : DIM]
    ]
    return [l1, l2, l3, l4]
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKey)
    this.canvas.remove()
  }
}
