// Why a frame came late (docs/PROFILER.md, hitch explanations): every
// contributor the recording has evidence for, largest first, instead of
// a single guess. The compositor's own CPU phases in the frame before the
// gap (with what triggered its DOM read and the elements read), the GPU
// still busy with the previous frame, and the browser's long animation
// frames overlapping the gap: each script with its source and forced
// layout, style/layout/paint, and the time the browser didn't attribute
// (GC, its own work). Pure: no DOM.

import type { CpuBreakdown, FrameSample, LongFrame } from './profiler'

export type FactorKind =
  /** The compositor's DOM read (CpuBreakdown.read). */
  | 'read'
  /** Its buffer and texture uploads. */
  | 'upload'
  /** Its command encoding and submit. */
  | 'encode'
  /** Effects hooks (beforeFrame, onFrame, onGlyph). */
  | 'hooks'
  /** The rest of its frame. */
  | 'compositor'
  /** The GPU still on the previous frame. */
  | 'gpu'
  /** A script in a long animation frame (not the compositor's). */
  | 'script'
  /** Style, layout and paint at the end of a long animation frame. */
  | 'layout'
  /** Time nothing recorded accounts for. */
  | 'unattributed'

/** One contributor to a hitch. */
export interface Factor {
  kind: FactorKind
  ms: number
  /** One line, for people. */
  text: string
  /** Elements involved (ElementRegistry indexes, Recording.elements). */
  els?: number[]
  /** A script's source: url, and `:char` position when known. */
  source?: string
}

/** The old single-cause categories (Hitch.cause). */
export type HitchCause = 'compositor cpu' | 'gpu' | 'script' | 'outside'

export function causeOf(k: FactorKind | undefined): HitchCause {
  switch (k) {
    case 'read':
    case 'upload':
    case 'encode':
    case 'hooks':
    case 'compositor':
      return 'compositor cpu'
    case 'gpu':
      return 'gpu'
    case 'script':
      return 'script'
    default:
      return 'outside'
  }
}

const ms = (v: number): string => `${v.toFixed(1)} ms`

/** Folded trigger events as text: "attributes div.card[class] ×3". */
function triggers(
  s: FrameSample,
  path: (i: number) => string | undefined
): { text: string; els: number[] } {
  const ev = s.why?.events ?? []
  const els: number[] = []
  const parts = ev.slice(0, 3).map((e) => {
    if (e.el !== undefined) {
      els.push(e.el)
    }
    const where = e.el !== undefined ? ` ${path(e.el) ?? `#${e.el}`}` : ''
    const what = e.detail ? `[${e.detail}]` : ''
    return `${e.kind}${where}${what}${e.n ? ` ×${e.n}` : ''}`
  })
  const rest = ev.length - parts.length + (s.why?.more ?? 0)
  return {
    text: parts.length
      ? `${parts.join(', ')}${rest > 0 ? `, +${rest} more` : ''}`
      : '',
    els
  }
}

export interface ExplainInput {
  /** The frame whose CPU work preceded the gap (paced frames), or null. */
  before: FrameSample | null
  /** The previous frame (its GPU work may run into the gap). */
  prev: FrameSample | null
  /** The late frame. */
  late: FrameSample
  /** The gap, absolute ms (performance.now). */
  from: number
  to: number
  refresh: number
  /** Recording origin, absolute ms: LongFrame times are relative to it. */
  origin: number
  longFrames: readonly LongFrame[]
  /** Element paths by index (for the text). */
  path?: (i: number) => string | undefined
}

/** The contributors to one hitch, largest first (at least one). */
export function explain(x: ExplainInput): Factor[] {
  const { before, prev, refresh } = x
  const path = x.path ?? (() => undefined)
  const out: Factor[] = []
  const floor = Math.max(1, refresh * 0.1)

  if (before) {
    const c: CpuBreakdown = before.cpu
    if (c.read >= floor) {
      const t = triggers(before, path)
      const scopes = before.why?.scopes ?? []
      const n = before.why?.scopeCount ?? 0
      const where = scopes
        .slice(0, 2)
        .map((i) => path(i))
        .filter(Boolean)
        .join(', ')
      out.push({
        kind: 'read',
        ms: c.read,
        text: [
          `${before.read} DOM read of ${before.readElements} element${before.readElements === 1 ? '' : 's'}`,
          before.cause ? `(${before.cause})` : '',
          where ? `in ${where}${n > 2 ? ` +${n - 2}` : ''}` : '',
          t.text ? `after ${t.text}` : ''
        ]
          .filter(Boolean)
          .join(' '),
        els: [...new Set([...scopes.slice(0, 8), ...t.els])]
      })
    }
    if (c.upload >= floor) {
      const layers = Object.entries(before.uploads)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .map(([l, v]) => `${l} ${ms(v ?? 0)}`)
      out.push({
        kind: 'upload',
        ms: c.upload,
        text: `uploads: ${layers.join(', ') || 'buffers'}`
      })
    }
    if (c.encode >= floor) {
      out.push({
        kind: 'encode',
        ms: c.encode,
        text: `encoding ${before.draws} draws in ${before.batches} batches${c.cull >= 1 ? ` (culling ${ms(c.cull)})` : ''}`
      })
    }
    if (c.hooks >= floor) {
      const alive = before.why?.alive ?? []
      out.push({
        kind: 'hooks',
        ms: c.hooks,
        text: `effects hooks${alive.length ? ` (running: ${alive.join(', ')})` : ''}`
      })
    }
    if (c.other >= floor) {
      out.push({
        kind: 'compositor',
        ms: c.other,
        text: 'compositor bookkeeping (dirty tracking, canvas placement)'
      })
    }
  }

  const gpu = prev?.gpu
  if (
    prev &&
    gpu &&
    gpu.totalMs > refresh * 0.8 &&
    prev.t + gpu.totalMs > x.from
  ) {
    const top = [...gpu.spans].sort((a, b) => b.ms - a.ms).slice(0, 3)
    out.push({
      kind: 'gpu',
      ms: gpu.totalMs,
      text: `GPU on the previous frame: ${top.map((p) => `${p.label} ${ms(p.ms)}`).join(', ')}`
    })
  }

  // The compositor's own frame callbacks show up as scripts too.
  const own = [before, prev, x.late]
    .map((s) => (s?.start !== undefined ? s.start - x.origin : null))
    .filter((v): v is number => v !== null)
  const isOwn = (at: number | undefined): boolean =>
    at !== undefined && own.some((o) => Math.abs(o - at) < 1)
  const from = x.from - x.origin
  const to = x.to - x.origin
  // Time inside the gap: a long frame (or a script) running past either
  // end counts only for its part in it.
  const inGap = (a: number, b: number): number =>
    Math.max(0, Math.min(b, to) - Math.max(a, from))
  for (const lf of x.longFrames) {
    const end = lf.at + lf.duration
    const span = inGap(lf.at, end)
    if (span <= 0) {
      continue
    }
    let scripted = 0
    let forced = 0
    for (const s of lf.scripts) {
      const t = s.at !== undefined ? inGap(s.at, s.at + s.ms) : s.ms
      scripted += t
      forced += s.forced ?? 0
      if (isOwn(s.at) || t < floor) {
        continue
      }
      out.push({
        kind: 'script',
        ms: t,
        text: `${s.name}${s.forced ? ` (forced layout ${ms(s.forced)})` : ''}${t < s.ms - 0.5 ? ` (${ms(s.ms)} in all)` : ''}`,
        source: s.source
      })
    }
    const layout = inGap(end - Math.max(0, lf.layout), end)
    if (layout >= floor) {
      out.push({
        kind: 'layout',
        ms: layout,
        text: `style, layout and paint at the end of a ${ms(lf.duration)} long frame${forced >= 1 ? `; scripts forced ${ms(forced)} more` : ''}`
      })
    }
    const rest = span - layout - scripted
    if (rest >= Math.max(floor, 2)) {
      out.push({
        kind: 'unattributed',
        ms: rest,
        text: `${ms(rest)} of a ${ms(lf.duration)} long frame not attributed (GC, browser work, or script it didn't name)`
      })
    }
  }

  if (out.length === 0) {
    out.push({
      kind: 'unattributed',
      ms: Math.max(0, x.to - x.from - refresh),
      text: 'nothing recorded explains it (layout or paint under a long-frame threshold, GC, the GPU process, or another tab)'
    })
  }
  return out.sort((a, b) => b.ms - a.ms)
}

/** The factors as one line (Hitch.detail). */
export function factorsText(fs: readonly Factor[]): string {
  return fs
    .slice(0, 3)
    .map((f) => `${f.kind} ${ms(f.ms)}: ${f.text}`)
    .join('; ')
}
