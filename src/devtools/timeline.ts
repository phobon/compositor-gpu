// The Timeline view (docs/PROFILER.md, M6b): one canvas with lanes over
// time for a recording.
//
//   marks     the recording's marks, and the time axis
//   frames    each frame's interval (its height, red when late), the
//             refresh interval dashed, a marker on each late frame
//   cpu       the compositor's frame callback, split by phase
//   gpu       the frame's GPU time, placed after its CPU work (GPU
//             timestamps don't share the page clock: the place is
//             approximate, the length is measured)
//   main      long animation frames: their scripts (the compositor's own
//             callback grey), and style/layout/paint at the end
//
// Wheel zooms around the pointer (with Shift, or a horizontal wheel,
// pans), dragging pans, a click selects the frame under the pointer.

import { COLORS, fmtAt, fmtMs, type Model, PHASES } from './model'

const LABEL_W = 56
const AXIS_H = 18
const LANES = [
  { key: 'frames', label: 'frames', h: 46 },
  { key: 'cpu', label: 'cpu', h: 16 },
  { key: 'gpu', label: 'gpu', h: 16 },
  { key: 'main', label: 'main', h: 22 }
] as const
type LaneKey = (typeof LANES)[number]['key']
const GAP = 4
export const TIMELINE_H = AXIS_H + LANES.reduce((n, l) => n + l.h + GAP, 0) + 6

export interface TimelineOptions {
  onSelect(i: number): void
  /** A line describing what's under the pointer (null: nothing). */
  onHover(text: string | null): void
}

interface Hit {
  x0: number
  x1: number
  lane: LaneKey
  text: string
  frame?: number
}

export class Timeline {
  readonly canvas: HTMLCanvasElement
  private readonly g: CanvasRenderingContext2D | null
  private model: Model | null = null
  private t0 = 0
  private t1 = 1
  private selected = -1
  private width = 0
  private hits: Hit[] = []
  private queued = false
  private readonly ro: ResizeObserver
  private drag: { x: number; t0: number; t1: number; moved: boolean } | null =
    null

  constructor(
    private readonly parent: HTMLElement,
    private readonly opts: TimelineOptions
  ) {
    const c = document.createElement('canvas')
    c.className = 'timeline'
    c.style.height = `${TIMELINE_H}px`
    c.tabIndex = 0
    c.setAttribute('role', 'img')
    c.setAttribute('aria-label', 'frame timeline')
    parent.append(c)
    this.canvas = c
    this.g = c.getContext('2d')
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(parent)
    c.addEventListener('wheel', this.onWheel, { passive: false })
    c.addEventListener('pointerdown', this.onDown)
    c.addEventListener('pointermove', this.onMove)
    c.addEventListener('pointerup', this.onUp)
    c.addEventListener('pointerleave', () => opts.onHover(null))
    this.resize()
  }

  /** Show `model`; `keep` keeps the visible range (a live refresh). */
  setModel(model: Model | null, keep = false): void {
    const follow = keep && this.model !== null && this.t1 >= this.model.end - 1
    const span = this.t1 - this.t0
    this.model = model
    if (!model) {
      this.draw()
      return
    }
    if (!keep) {
      this.fit()
      return
    }
    if (follow) {
      // Following the live edge: keep the span, end at the newest frame.
      this.t1 = model.end
      this.t0 = model.end - span
    }
    this.queue()
  }

  fit(): void {
    const m = this.model
    if (m) {
      const pad = (m.end - m.start) * 0.01
      this.t0 = m.start - pad
      this.t1 = m.end + pad
    }
    this.queue()
  }

  /** Select frame i and bring it into view. */
  select(i: number, reveal = true): void {
    this.selected = i
    const m = this.model
    if (m && reveal && i >= 0) {
      const s = m.samples[i]
      const a = m.at(i) - (s?.dt ?? 0)
      const b = m.at(i)
      const span = this.t1 - this.t0
      if (a < this.t0 || b > this.t1) {
        this.t0 = (a + b) / 2 - span / 2
        this.t1 = this.t0 + span
      }
    }
    this.queue()
  }

  destroy(): void {
    this.ro.disconnect()
    this.canvas.remove()
  }

  private resize(): void {
    const w = this.parent.clientWidth
    if (w === this.width || w === 0) {
      return
    }
    this.width = w
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(TIMELINE_H * dpr)
    this.canvas.style.width = `${w}px`
    this.queue()
  }

  private queue(): void {
    if (this.queued) {
      return
    }
    this.queued = true
    requestAnimationFrame(() => {
      this.queued = false
      this.draw()
    })
  }

  private x(t: number): number {
    return (
      LABEL_W + ((t - this.t0) / (this.t1 - this.t0)) * (this.width - LABEL_W)
    )
  }

  private t(x: number): number {
    return (
      this.t0 + ((x - LABEL_W) / (this.width - LABEL_W)) * (this.t1 - this.t0)
    )
  }

  private laneY(key: LaneKey): [number, number] {
    let y = AXIS_H
    for (const l of LANES) {
      if (l.key === key) {
        return [y, l.h]
      }
      y += l.h + GAP
    }
    return [y, 0]
  }

  private draw(): void {
    const g = this.g
    if (!g || this.width === 0) {
      return
    }
    const dpr = window.devicePixelRatio || 1
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, this.width, TIMELINE_H)
    g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    g.textBaseline = 'middle'
    // Lane labels.
    g.fillStyle = '#9ca3af'
    for (const l of LANES) {
      const [y, h] = this.laneY(l.key)
      g.fillText(l.label, 6, y + h / 2)
      g.fillStyle = 'rgba(255,255,255,0.03)'
      g.fillRect(LABEL_W, y, this.width - LABEL_W, h)
      g.fillStyle = '#9ca3af'
    }
    const m = this.model
    this.hits = []
    if (!m || m.samples.length === 0) {
      g.fillText('no frames', LABEL_W + 8, AXIS_H + 20)
      return
    }
    g.save()
    g.beginPath()
    g.rect(LABEL_W, 0, this.width - LABEL_W, TIMELINE_H)
    g.clip()
    this.drawAxis(g, m)
    this.drawFrames(g, m)
    this.drawCpuGpu(g, m)
    this.drawMain(g, m)
    // The selection, across the lanes.
    const s = m.samples[this.selected]
    if (s) {
      const b = this.x(m.at(this.selected))
      const a = this.x(m.at(this.selected) - s.dt)
      g.fillStyle = 'rgba(56,189,248,0.12)'
      g.fillRect(a, AXIS_H, Math.max(2, b - a), TIMELINE_H - AXIS_H)
      g.strokeStyle = '#38bdf8'
      g.lineWidth = 1
      g.strokeRect(
        a + 0.5,
        AXIS_H + 0.5,
        Math.max(2, b - a) - 1,
        TIMELINE_H - AXIS_H - 1
      )
    }
    g.restore()
  }

  private drawAxis(g: CanvasRenderingContext2D, m: Model): void {
    const span = this.t1 - this.t0
    const target = span / Math.max(1, (this.width - LABEL_W) / 90)
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
    const step = steps.find((s) => s >= target) ?? 10000
    g.fillStyle = '#6b7280'
    g.strokeStyle = 'rgba(255,255,255,0.06)'
    g.lineWidth = 1
    for (let t = Math.ceil(this.t0 / step) * step; t <= this.t1; t += step) {
      const x = Math.round(this.x(t)) + 0.5
      g.beginPath()
      g.moveTo(x, AXIS_H - 4)
      g.lineTo(x, TIMELINE_H)
      g.stroke()
      g.fillText(step >= 100 ? fmtAt(t) : `${t.toFixed(0)} ms`, x + 3, 7)
    }
    for (const mk of m.report.marks) {
      const x = Math.round(this.x(mk.at)) + 0.5
      g.strokeStyle = COLORS.mark
      g.setLineDash([3, 3])
      g.beginPath()
      g.moveTo(x, 10)
      g.lineTo(x, TIMELINE_H)
      g.stroke()
      g.setLineDash([])
      g.fillStyle = COLORS.mark
      g.fillText(mk.label, x + 3, 14)
    }
  }

  private visible(m: Model): [number, number] {
    const a = Math.max(0, m.frameAt(this.t0) - 1)
    const b = Math.min(m.samples.length - 1, m.frameAt(this.t1) + 1)
    return [a, b]
  }

  private drawFrames(g: CanvasRenderingContext2D, m: Model): void {
    const [y, h] = this.laneY('frames')
    const max = m.refresh * 3
    const base = y + h
    const [a, b] = this.visible(m)
    const lateSet = new Set(m.late)
    for (let i = a; i <= b; i++) {
      const s = m.samples[i]
      if (!s) {
        continue
      }
      const late = lateSet.has(i)
      const gap = late
        ? m.hitch(i).dt
        : s.continuous
          ? s.dt
          : Math.min(s.dt, s.wait || s.dt)
      const x1 = this.x(m.at(i))
      const x0 = this.x(m.at(i) - s.dt)
      const bh = (Math.min(gap, max) / max) * (h - 4)
      g.fillStyle = late ? COLORS.late : s.skipped ? COLORS.skipped : COLORS.ok
      g.fillRect(x0 + 0.5, base - bh, Math.max(1, x1 - x0 - 1), bh)
      this.hits.push({
        x0,
        x1,
        lane: 'frames',
        frame: i,
        text: `frame ${s.id} at ${fmtAt(m.at(i))}: ${fmtMs(s.dt)}${late ? `, late (${m.hitch(i).missed} missed): ${m.hitch(i).cause}` : ''}${s.read !== 'none' ? `, ${s.read} read` : ''}`
      })
      if (late) {
        g.fillStyle = COLORS.late
        g.beginPath()
        g.moveTo(x1 - 4, y)
        g.lineTo(x1 + 4, y)
        g.lineTo(x1, y + 5)
        g.fill()
      }
    }
    const ry = base - (m.refresh / max) * (h - 4)
    g.strokeStyle = 'rgba(255,255,255,0.35)'
    g.setLineDash([3, 3])
    g.beginPath()
    g.moveTo(LABEL_W, Math.round(ry) + 0.5)
    g.lineTo(this.width, Math.round(ry) + 0.5)
    g.stroke()
    g.setLineDash([])
  }

  private drawCpuGpu(g: CanvasRenderingContext2D, m: Model): void {
    const [cy, ch] = this.laneY('cpu')
    const [gy, gh] = this.laneY('gpu')
    const [a, b] = this.visible(m)
    for (let i = a; i <= b; i++) {
      const s = m.samples[i]
      if (!s) {
        continue
      }
      const start = (s.start ?? s.t) - m.origin
      let t = start
      for (const k of PHASES) {
        const v = s.cpu[k]
        if (v <= 0) {
          continue
        }
        const x0 = this.x(t)
        const x1 = this.x(t + v)
        g.fillStyle = COLORS[k]
        g.fillRect(x0, cy + 2, Math.max(1, x1 - x0), ch - 4)
        t += v
      }
      this.hits.push({
        x0: this.x(start),
        x1: Math.max(this.x(start + s.cpu.total), this.x(start) + 2),
        lane: 'cpu',
        frame: i,
        text: `compositor ${fmtMs(s.cpu.total)}: ${PHASES.filter(
          (k) => s.cpu[k] >= 0.05
        )
          .map((k) => `${k} ${fmtMs(s.cpu[k])}`)
          .join(', ')}`
      })
      const gpu = s.gpu
      if (gpu) {
        const g0 = start + s.cpu.total
        const x0 = this.x(g0)
        const x1 = this.x(g0 + gpu.totalMs)
        g.fillStyle = COLORS.gpu
        g.globalAlpha = 0.7
        g.fillRect(x0, gy + 2, Math.max(1, x1 - x0), gh - 4)
        g.globalAlpha = 1
        const top = [...gpu.spans].sort((p, q) => q.ms - p.ms).slice(0, 3)
        if (x1 - x0 > 40 && top[0]) {
          g.fillStyle = '#111114'
          g.fillText(top[0].label, x0 + 3, gy + gh / 2, x1 - x0 - 6)
        }
        this.hits.push({
          x0,
          x1: Math.max(x1, x0 + 2),
          lane: 'gpu',
          frame: i,
          text: `GPU ${fmtMs(gpu.totalMs)}: ${top.map((p) => `${p.label} ${fmtMs(p.ms)}`).join(', ')}`
        })
      }
    }
  }

  private drawMain(g: CanvasRenderingContext2D, m: Model): void {
    const [y, h] = this.laneY('main')
    const own = new Set(
      m.samples
        .map((s) =>
          s.start !== undefined ? Math.round(s.start - m.origin) : null
        )
        .filter((v): v is number => v !== null)
    )
    for (const lf of m.report.longFrames) {
      if (lf.at + lf.duration < this.t0 || lf.at > this.t1) {
        continue
      }
      const x0 = this.x(lf.at)
      const x1 = this.x(lf.at + lf.duration)
      g.fillStyle = COLORS.loaf
      g.fillRect(x0, y + 1, Math.max(1, x1 - x0), h - 2)
      for (const s of lf.scripts) {
        if (s.at === undefined) {
          continue
        }
        const mine = own.has(Math.round(s.at))
        const a = this.x(s.at)
        const b = this.x(s.at + s.ms)
        g.fillStyle = mine ? COLORS.compositor : COLORS.script
        g.fillRect(a, y + 4, Math.max(1, b - a), h - 8)
        if (b - a > 50) {
          g.fillStyle = '#111114'
          g.fillText(s.name, a + 3, y + h / 2, b - a - 6)
        }
        this.hits.push({
          x0: a,
          x1: Math.max(b, a + 2),
          lane: 'main',
          text: `${mine ? 'compositor frame' : s.name} ${fmtMs(s.ms)}${s.forced ? `, forced layout ${fmtMs(s.forced)}` : ''}${s.source ? ` — ${s.source}` : ''}`
        })
      }
      if (lf.layout > 0) {
        const a = this.x(lf.at + lf.duration - lf.layout)
        g.fillStyle = COLORS.layout
        g.fillRect(a, y + 4, Math.max(1, x1 - a), h - 8)
        this.hits.push({
          x0: a,
          x1: Math.max(x1, a + 2),
          lane: 'main',
          text: `style, layout and paint ${fmtMs(lf.layout)}`
        })
      }
      this.hits.push({
        x0,
        x1,
        lane: 'main',
        text: `long animation frame ${fmtMs(lf.duration)} (blocking ${fmtMs(lf.blocking)})`
      })
    }
  }

  private hitAt(x: number, y: number): Hit | null {
    let lane: LaneKey | null = null
    for (const l of LANES) {
      const [ly, lh] = this.laneY(l.key)
      if (y >= ly && y < ly + lh + GAP) {
        lane = l.key
      }
    }
    if (!lane) {
      return null
    }
    // The narrowest hit under the pointer (scripts over their frame).
    let best: Hit | null = null
    for (const hit of this.hits) {
      if (hit.lane === lane && x >= hit.x0 - 1 && x <= hit.x1 + 1) {
        if (!best || hit.x1 - hit.x0 < best.x1 - best.x0) {
          best = hit
        }
      }
    }
    return best
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.model) {
      return
    }
    e.preventDefault()
    const rect = this.canvas.getBoundingClientRect()
    const px = e.clientX - rect.left
    const span = this.t1 - this.t0
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d =
        ((e.shiftKey ? e.deltaY : e.deltaX) / (this.width - LABEL_W)) * span
      this.t0 += d
      this.t1 += d
    } else {
      const at = this.t(Math.max(LABEL_W, px))
      const k = Math.exp(e.deltaY * 0.002)
      const next = Math.min(
        Math.max(span * k, 5),
        (this.model.end - this.model.start) * 4 + 100
      )
      this.t0 = at - ((at - this.t0) / span) * next
      this.t1 = this.t0 + next
    }
    this.queue()
  }

  private onDown = (e: PointerEvent): void => {
    this.drag = { x: e.clientX, t0: this.t0, t1: this.t1, moved: false }
    this.canvas.setPointerCapture(e.pointerId)
  }

  private onMove = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect()
    const d = this.drag
    if (d) {
      const dx = e.clientX - d.x
      if (Math.abs(dx) > 3) {
        d.moved = true
      }
      if (d.moved) {
        const dt = (dx / (this.width - LABEL_W)) * (d.t1 - d.t0)
        this.t0 = d.t0 - dt
        this.t1 = d.t1 - dt
        this.queue()
        return
      }
    }
    const hit = this.hitAt(e.clientX - rect.left, e.clientY - rect.top)
    this.opts.onHover(hit ? hit.text : null)
  }

  private onUp = (e: PointerEvent): void => {
    const d = this.drag
    this.drag = null
    if (!d || d.moved || !this.model) {
      return
    }
    const rect = this.canvas.getBoundingClientRect()
    const px = e.clientX - rect.left
    if (px < LABEL_W) {
      return
    }
    const hit = this.hitAt(px, e.clientY - rect.top)
    const i = hit?.frame ?? this.model.frameAt(this.t(px))
    this.opts.onSelect(i)
  }
}
