// The live HUD (compositor.profile.hud()): a fixed 2D canvas in the
// bottom-left corner drawing the most recent frames. Each column is a
// frame: CPU time stacked by phase (read, hooks, upload, encode, other),
// GPU time as a line, and the frame interval behind them, red when the
// frame came late. The dashed line is the refresh budget. It sits outside
// the mirrored root, above the compositor canvas, and is never mirrored.

import {
  estimateRefresh,
  type FrameSample,
  missed,
  paced,
  pct
} from './profiler'

const W = 320
const H = 132
const GRAPH_TOP = 34
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

export class Hud {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D | null
  private text = ''
  private textAt = 0

  constructor() {
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

    // The summary refreshes four times a second (cheaper, and readable).
    const now = performance.now()
    if (now - this.textAt > 250) {
      this.textAt = now
      this.text = summaryLine(frames, refresh)
    }
    const last = frames[frames.length - 1]
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'
    g.fillStyle = '#e5e7eb'
    g.fillText(this.text, 6, 13)
    g.fillStyle = '#9ca3af'
    if (last) {
      const read =
        last.read === 'none'
          ? 'no read'
          : `${last.read} read ${last.readElements} el${last.cause ? ` · ${last.cause}` : ''}`
      g.fillText(read.slice(0, 50), 6, 26)
    }
  }

  destroy(): void {
    this.canvas.remove()
  }
}

function summaryLine(frames: FrameSample[], refresh: number): string {
  const cpu = pct(frames.map((s) => s.cpu.total))
  const timed = frames.filter((s) => s.gpu)
  const gpu = timed.length ? pct(timed.map((s) => s.gpu?.totalMs ?? 0)) : null
  const late = frames.filter((s) => missed(s, refresh) > 0).length
  const hz = (1000 / refresh).toFixed(0)
  return `${hz}Hz cpu ${cpu.p50.toFixed(1)}/${cpu.p95.toFixed(1)}${
    gpu ? ` gpu ${gpu.p50.toFixed(1)}/${gpu.p95.toFixed(1)}` : ''
  } late ${late}/${frames.length}`
}
