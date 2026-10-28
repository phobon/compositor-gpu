// The Live view (docs/PROFILER.md, M6b): the most recent frames as they
// happen (each column a frame: compositor CPU stacked by phase, GPU time
// as a line, the frame interval behind them, red when late; the refresh
// interval dashed), with their percentiles above.

import {
  estimateRefresh,
  type FrameSample,
  missed,
  paced,
  pct
} from '../profile/profiler'
import { COLORS, fmtMs, h, PHASES } from './model'

const GRAPH_H = 120
const COL = 3

export class LiveView {
  readonly root: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly g: CanvasRenderingContext2D | null
  private readonly numbers: HTMLElement
  private textAt = 0

  constructor() {
    this.canvas = h('canvas', { class: 'live', 'aria-hidden': 'true' })
    this.canvas.style.height = `${GRAPH_H}px`
    this.g = this.canvas.getContext('2d')
    this.numbers = h('div', { class: 'cards' })
    this.root = h(
      'div',
      { class: 'liveview' },
      this.numbers,
      this.canvas,
      h('div', {
        class: 'legend',
        text: ''
      })
    )
    const legend = this.root.lastElementChild as HTMLElement
    for (const k of PHASES) {
      const sw = h('i')
      sw.style.background = COLORS[k]
      legend.append(h('span', {}, sw, k))
    }
    const gpu = h('i')
    gpu.style.background = COLORS.gpu
    legend.append(h('span', {}, gpu, 'gpu'))
    const late = h('i')
    late.style.background = COLORS.late
    legend.append(h('span', {}, late, 'late frame'))
  }

  draw(frames: FrameSample[]): void {
    const g = this.g
    const w = this.canvas.clientWidth
    if (!g || w === 0) {
      return
    }
    const dpr = window.devicePixelRatio || 1
    if (this.canvas.width !== Math.round(w * dpr)) {
      this.canvas.width = Math.round(w * dpr)
      this.canvas.height = Math.round(GRAPH_H * dpr)
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, GRAPH_H)
    const refresh = estimateRefresh(frames)
    const top = refresh * 3
    const y = (ms: number): number =>
      GRAPH_H - 2 - (Math.min(ms, top) / top) * (GRAPH_H - 6)
    const shown = frames.slice(-Math.floor(w / COL))
    let x = w - shown.length * COL
    for (const s of shown) {
      if (paced(s, refresh)) {
        g.fillStyle =
          missed(s, refresh) > 0
            ? 'rgba(239,68,68,0.55)'
            : 'rgba(255,255,255,0.08)'
        g.fillRect(x, y(s.dt), COL - 1, GRAPH_H - y(s.dt))
      }
      let base = GRAPH_H - 2
      for (const k of PHASES) {
        const v = s.cpu[k]
        if (v <= 0) {
          continue
        }
        const hh = Math.max(0.5, (Math.min(v, top) / top) * (GRAPH_H - 6))
        g.fillStyle = COLORS[k]
        g.fillRect(x, base - hh, COL - 1, hh)
        base -= hh
      }
      x += COL
    }
    g.strokeStyle = COLORS.gpu
    g.lineWidth = 1
    g.beginPath()
    x = w - shown.length * COL
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
    g.strokeStyle = 'rgba(255,255,255,0.4)'
    g.beginPath()
    g.moveTo(0, Math.round(y(refresh)) + 0.5)
    g.lineTo(w, Math.round(y(refresh)) + 0.5)
    g.stroke()
    g.setLineDash([])

    const now = performance.now()
    if (now - this.textAt > 250) {
      this.textAt = now
      this.cards(shown, refresh)
    }
  }

  private cards(frames: FrameSample[], refresh: number): void {
    const cpu = pct(frames.map((s) => s.cpu.total))
    const timed = frames.filter((s) => s.gpu)
    const gpu = timed.length ? pct(timed.map((s) => s.gpu?.totalMs ?? 0)) : null
    const late = frames.filter((s) => missed(s, refresh) > 0).length
    const reads = frames.filter((s) => s.read !== 'none').length
    const card = (k: string, v: string, bad = false): HTMLElement =>
      h(
        'div',
        { class: `card${bad ? ' bad' : ''}` },
        h('div', { class: 'v', text: v }),
        h('div', { class: 'k', text: k })
      )
    this.numbers.replaceChildren(
      card('refresh', `${(1000 / refresh).toFixed(0)} Hz`),
      card(
        'compositor p50 / p95',
        `${fmtMs(cpu.p50)} / ${fmtMs(cpu.p95)}`,
        cpu.p95 > refresh * 0.5
      ),
      card(
        'GPU p50 / p95',
        gpu ? `${fmtMs(gpu.p50)} / ${fmtMs(gpu.p95)}` : 'n/a',
        (gpu?.p95 ?? 0) > refresh * 0.8
      ),
      card('late frames', `${late} / ${frames.length}`, late > 0),
      card('DOM reads', `${reads}`)
    )
  }
}
