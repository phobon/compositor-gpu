// The M5 budget (docs/EFFECTS.md, Budget Q20), run by
// `npm run test:profile -- --morph` (test/profile/run.ts): morphs played
// back to back on the playground pages, each scored against
//
//   dropped frames   0 over the morphs
//   gpu total p95    text morphs (morph-*): at most 1.5 ms above the same
//                    page with the loop running and nothing drawn (its
//                    -idle scenario); layout morphs (layout-*): at most
//                    7.5 ms in all (90% of a 120 Hz frame), since they
//                    redraw the moving page and run a full-screen pass
//                    every frame (amended 2026-10-28, ROADMAP M5 budget)
//   capture() p95    at most 12 ms
//   cpu total p95    at most 2 ms per morph frame
//
// Only the frames while a morph plays count for dropped, gpu and cpu (not
// the capture() and settle between them). Meaningful on the real GPU,
// headed at dpr 2 (`--headed --dpr 2`); on SwiftShader only capture() and
// nothing is scored (capture() waits on the GPU too, and slow frames
// inflate the CPU column): the table prints what it measured.
import type { Page } from 'playwright'
import {
  type Pct,
  type ProfileReport,
  type ProfileSummary,
  summarize
} from '../../src/profile/profiler'

export const BUDGET = {
  dropped: 0,
  gpuOverIdle: 1.5,
  /** Layout morphs: total GPU p95, ms. */
  gpuLayout: 7.5,
  capture: 12,
  cpu: 2
}

interface Scenario {
  name: string
  page: 'morph.html' | 'layout.html'
  /** Nothing drawn, the loop running: the baseline for gpu. */
  idle?: boolean
  kind?: 'text' | 'text-wave' | 'assemble' | 'scatter' | 'swap' | 'swap-wave'
}

export const MORPH_SCENARIOS: Scenario[] = [
  { name: 'morph-idle', page: 'morph.html', idle: true },
  { name: 'morph-text', page: 'morph.html', kind: 'text' },
  { name: 'morph-text-wave', page: 'morph.html', kind: 'text-wave' },
  { name: 'morph-assemble', page: 'morph.html', kind: 'assemble' },
  { name: 'morph-scatter', page: 'morph.html', kind: 'scatter' },
  { name: 'layout-idle', page: 'layout.html', idle: true },
  { name: 'layout-swap', page: 'layout.html', kind: 'swap' },
  { name: 'layout-swap-wave', page: 'layout.html', kind: 'swap-wave' }
]

export interface MorphResult {
  name: string
  report: ProfileReport
  /** The morph frames only (all frames for an idle scenario). */
  summary: ProfileSummary
  captures: number[]
}

/** Percentile p (0..1) of `xs`, nearest rank. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) {
    return Number.NaN
  }
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] ?? Number.NaN
}

/** Record one scenario on the page already open at its playground. */
export async function recordMorph(
  page: Page,
  sc: Scenario,
  count: number,
  ms: number,
  idleMs: number
): Promise<MorphResult | null> {
  const out = await page.evaluate(
    async ({ sc, count, ms, idleMs }) => {
      const gpu = window.__gpu
      const fx = (window as unknown as { __fx?: import('@/fx').Effects }).__fx
      if (!gpu || !fx) {
        return null
      }
      const raf = (): Promise<number> =>
        new Promise((r) => requestAnimationFrame(r))
      for (let i = 0; i < 10; i++) {
        await raf()
      }
      const windows: [number, number][] = []
      const captures: number[] = []
      if (sc.idle) {
        // A continuous layer drawing one transparent CSS px keeps the
        // loop running and the page redrawn each frame (an active layer
        // turns scene reuse off), as while a morph plays.
        const keep = fx.layer({
          name: 'budget-idle',
          count: 1,
          stride: 1,
          continuous: true,
          vertex:
            'fn vertex(i : u32, corner : vec2f) -> Quad { var q : Quad; q.pos = corner; q.uv = corner; return q; }',
          fragment:
            'fn fragment(q : Quad, i : u32) -> vec4f { return vec4f(0.0); }'
        })
        for (let i = 0; i < 10; i++) {
          await raf()
        }
        gpu.profile.start()
        const t0 = performance.now()
        while (performance.now() - t0 < idleMs) {
          await raf()
        }
        windows.push([t0, performance.now()])
        const report = await gpu.profile.stop()
        keep.destroy()
        return { report, windows, captures }
      }
      gpu.profile.start()
      for (let i = 0; i < count; i++) {
        const r =
          sc.page === 'morph.html'
            ? await window.__morph?.run(
                sc.kind as 'text' | 'text-wave' | 'assemble' | 'scatter',
                ms
              )
            : await window.__layout?.run(sc.kind === 'swap-wave', ms)
        if (!r) {
          return null
        }
        windows.push([r.start, r.end])
        captures.push(r.captureMs)
        await raf()
        await raf()
      }
      const report = await gpu.profile.stop()
      return { report, windows, captures }
    },
    { sc, count, ms, idleMs }
  )
  if (!out?.report) {
    return null
  }
  const { report, windows, captures } = out
  const inside = report.samples.filter((s) =>
    windows.some(([a, b]) => s.t >= a && s.t <= b)
  )
  return {
    name: sc.name,
    report,
    summary: summarize(inside, report.refreshMs),
    captures
  }
}

const f = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : 'n/a')

/** Missed intervals of the hitches put outside the compositor (of the
 * twelve worst the summary keeps: an undercount when there are more). */
const outsideMissed = (s: ProfileSummary): number =>
  s.hitches
    .filter((h) => h.cause === 'outside')
    .reduce((n, h) => n + h.missed, 0)

const dropCol = (s: ProfileSummary): string => {
  const o = outsideMissed(s)
  return o > 0 ? `${s.dropped} (${o})` : String(s.dropped)
}
const p95 = (p: Pct | undefined): number => p?.p95 ?? Number.NaN

/** The budget table; `ok` is false when a measured number is over. */
export function verdict(
  results: readonly MorphResult[],
  software: boolean
): { table: string; ok: boolean } {
  const idle = new Map(
    results
      .filter((r) => r.name.endsWith('-idle'))
      .map((r) => [r.name.split('-')[0], r])
  )
  const rows: string[] = [
    'scenario            frames  dropped (outside)  gpu p95 (+idle)   capture p95  cpu p95  verdict',
    `budget                          ${BUDGET.dropped}   +${BUDGET.gpuOverIdle.toFixed(2)} (layout ${BUDGET.gpuLayout.toFixed(2)})          ${BUDGET.capture.toFixed(2)}         ${BUDGET.cpu.toFixed(2)}`
  ]
  let ok = true
  for (const r of results) {
    const s = r.summary
    if (r.name.endsWith('-idle')) {
      rows.push(
        `${r.name.padEnd(20)}${String(s.frames).padStart(6)}  ${(software ? 'n/a' : dropCol(s)).padStart(17)}  ${(software ? 'n/a' : f(p95(s.gpu?.total))).padStart(8)} (base)        -  ${f(p95(s.cpu.total)).padStart(7)}  -`
      )
      continue
    }
    const base = idle.get(r.name.split('-')[0])
    const gpuNow = p95(s.gpu?.total)
    const gpuBase = p95(base?.summary.gpu?.total)
    const over = gpuNow - gpuBase
    const cap = percentile(r.captures, 0.95)
    const cpu = p95(s.cpu.total)
    const fails: string[] = []
    if (!software && s.dropped - outsideMissed(s) > BUDGET.dropped) {
      fails.push('dropped')
    }
    const layout = r.name.startsWith('layout-')
    if (
      !software &&
      (layout
        ? gpuNow > BUDGET.gpuLayout
        : Number.isFinite(over) && over > BUDGET.gpuOverIdle)
    ) {
      fails.push('gpu')
    }
    if (!software && cap > BUDGET.capture) {
      fails.push('capture')
    }
    if (!software && cpu > BUDGET.cpu) {
      fails.push('cpu')
    }
    if (fails.length) {
      ok = false
    }
    const gpuCol = software
      ? 'n/a'
      : `${f(gpuNow)} (${over >= 0 ? '+' : ''}${f(over)})`
    rows.push(
      `${r.name.padEnd(20)}${String(s.frames).padStart(6)}  ${(software ? 'n/a' : dropCol(s)).padStart(17)}  ${gpuCol.padStart(15)}  ${f(cap).padStart(11)}  ${f(cpu).padStart(7)}  ${software ? 'not scored' : fails.length ? `over: ${fails.join(', ')}` : 'ok'}`
    )
  }
  if (software) {
    rows.push(
      '(software adapter: nothing scored; run --headed --dpr 2 on the real GPU)'
    )
  } else if (results.some((r) => !r.summary.gpu)) {
    rows.push(
      '(no GPU timestamps for some scenarios: their gpu column is n/a and not scored)'
    )
  }
  if (!software) {
    rows.push(
      "(dropped frames the profiler puts outside the compositor (layout, paint, GC, other script) are shown in brackets and don't count against the budget)"
    )
  }
  return { table: rows.join('\n'), ok }
}

/** Skip masks the layout morph's fragment takes (its `skip` param). */
export const LAYOUT_SKIPS: [string, number][] = [
  ['full', 0],
  ['no shapes', -1],
  ['no holes', 2],
  ['no pair loop', 4],
  ['no overlay', 8],
  ['no text morphs', 32],
  ['no layers', -32],
  ['no transforms', 64],
  ['nt: layers only', 80],
  ['nt: shader only', -96],
  ['live only', 16],
  ['live, no layers', -48],
  ['live, bare', -112]
]

/**
 * Where the layout morph's GPU time goes (`--diagnose`, layout.html
 * open): `count` swaps per skip mask, the post chain's and the whole
 * frame's GPU p95 while they play. Pixels differ with parts skipped; only
 * the timings mean anything.
 */
export async function diagnoseLayout(
  page: Page,
  count: number,
  ms: number
): Promise<string> {
  const rows = [
    'variant           frames  gpu p95  post p95 (alone)  overlay p95 (alone)  main p95 (alone)  capture p95  dropped'
  ]
  for (const [label, mask] of LAYOUT_SKIPS) {
    await page.evaluate((m) => {
      const lm = window.__layout?.morph as unknown as {
        pass: { params: Record<string, unknown> }
        shapes: { enabled: boolean }
      }
      // Negative: the svg shapes' layer off too (it draws for the
      // overlay); -1 that alone. "nt": no transforms, so the page isn't
      // redrawn and the pass and layers are timed on their own.
      lm.pass.params.skip = Math.abs(m) === 1 ? 0 : Math.abs(m)
      lm.shapes.enabled = m >= 0
    }, mask)
    const r = await recordMorph(
      page,
      { name: `layout-${label}`, page: 'layout.html', kind: 'swap' },
      count,
      ms,
      0
    )
    if (!r) {
      rows.push(`${label.padEnd(16)} no report`)
      continue
    }
    const s = r.summary
    const col = (k: string): string =>
      `${f(p95(s.gpu?.passes[k]))} (${f(p95(s.gpu?.alone?.[k]))})`.padStart(16)
    rows.push(
      `${label.padEnd(16)}${String(s.frames).padStart(7)}  ${f(p95(s.gpu?.total)).padStart(7)}  ${col('post')}  ${col('overlay').padStart(19)}  ${col('main')}  ${f(percentile(r.captures, 0.95)).padStart(11)}  ${String(s.dropped).padStart(7)}`
    )
  }
  await page.evaluate(() => {
    const lm = window.__layout?.morph as unknown as {
      pass: { params: Record<string, unknown> }
      shapes: { enabled: boolean }
    }
    lm.pass.params.skip = 0
    lm.shapes.enabled = true
  })
  return rows.join('\n')
}
