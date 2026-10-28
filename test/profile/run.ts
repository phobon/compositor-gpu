// Scenario profiler: records each scenario with compositor.profile in
// headless Chromium and prints frame pacing, the CPU breakdown, GPU pass
// timings (timestamp-query, when the adapter has it) and the worst hitches.
// Reports go to test/profile/out/<save>/<scenario>.json.
//
// Usage:
//   npm run test:profile                          # every scenario, n=400
//   npm run test:profile -- --only scroll,reveal
//   npm run test:profile -- --save before         # keep as a baseline
//   npm run test:profile -- --baseline before     # print deltas against it
//   npm run test:profile -- --url http://localhost:8000/duo
//       any page exposing its compositor as window.__gpu: scrolls it top to
//       bottom and back (--speed px per frame, default 12).
//   --headed   a visible window (the real GPU and display refresh), with
//              the HUD on (--hud adds it headless, --no-hud drops it)
//   --channel  with --headed: chrome (default), chrome-canary, msedge or
//              chromium (Playwright's own)
//   --keep     with --headed, leave the window open until you close it
//   --frames 0.25   scale each scenario's frame count
//   --viewport 1280x900
//   --dpr 2        device pixel ratio (default 1; a Retina display is 2)
//   --nocull       perf.html with CompositorOptions.cullDraws off (A/B)
//   --nodim        perf.html without its opacity: 0.8 cards (no groups)
//   --band         perf.html with CompositorOptions.canvasFill 'band'
//   --bandcanvas   with --band, cull draws to the canvas, not the band
//   --bandclear    perf.html with canvasFill 'band-clear' (margins cleared)
//   --nopatch      perf.html with CompositorOptions.patchEdits off
//   --noatlas      perf.html with CompositorOptions.groupAtlas off
//   --nopatchopacity  perf.html with CompositorOptions.patchOpacity off
//   --norefit      perf.html with CompositorOptions.refitBatches off
//   --nostrips     perf.html with CompositorOptions.reanchorStrips off
//   --noskip       perf.html with CompositorOptions.skipUnchanged off
//   --fixed        perf.html?fixed: a fixed header bar (viewport-space)
//   --groups N     elements the `groups` / `fade` scenarios put below
//                  opacity 1 (default 48)
//   --ballast N    perf.html?ballast=N: N rounds of extra fragment work
//                  per main-pass pixel (headroom sweep)
//   --morph        the M5 budget instead (test/profile/morph.ts): morphs
//                  on morph.html and layout.html scored against Q20;
//                  --morphs N per scenario (default 20), --ms play time
//                  (default 800), --only morph-text,layout-swap ...
//                  Exits 1 when a measured number is over budget. Run it
//                  `--headed --dpr 2` on the machine the budget is for.
//                  --diagnose adds the layout morph's GPU time by part
//                  (its fragment run with parts skipped).
//   --explain      the profiler's recorder core instead
//                  (test/profile/explain.ts): jank perf.html on purpose
//                  under the flight recorder and check save() explains it.
//
// SwiftShader (no GPU) numbers only mean something for the CPU columns.
// Each report records the run's adapter and browser (`run`); --baseline
// refuses GPU and pacing deltas against a baseline from another adapter
// (software vs hardware, or another vendor/architecture) and warns when
// the browser's major version differs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium, type Page } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import {
  formatReport,
  type Pct,
  type ProfileReport
} from '../../src/profile/profiler'
import { launchWithFallback } from '../lib/browser'
import { checkExplain } from './explain'
import {
  diagnoseLayout,
  MORPH_SCENARIOS,
  type MorphResult,
  recordMorph,
  verdict
} from './morph'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

export const SCENARIOS = [
  'idle',
  'scroll',
  'scroll-long',
  'mutate',
  'mutate-class',
  'mutate-text',
  'full-read',
  'css-transforms',
  'fx-transforms',
  'fx-one',
  'reveal',
  'blur-scroll',
  'groups',
  'fade'
]

/** Unquantised GPU timestamps (Chrome rounds them to 100 µs otherwise). */
const GPU_TIMING_ARGS = ['--enable-webgpu-developer-features']

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2)
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const flag = (name: string): boolean =>
  process.argv.slice(2).includes(`--${name}`)

/** Stop with a clear message when the page's compositor didn't start
 * (no WebGPU adapter in this browser). */
/** What a report was recorded on (saved with it as `run`). */
interface RunInfo {
  adapter: {
    vendor: string
    architecture: string
    device: string
    description: string
  } | null
  /** SwiftShader or another fallback adapter: GPU and pacing numbers
   * don't describe the machine. */
  software: boolean
  browser: string
  headed: boolean
}

type SavedReport = ProfileReport & { run?: RunInfo }

async function adapterInfo(page: Page): Promise<
  | (RunInfo['adapter'] & {
      fallback: boolean
    })
  | null
> {
  return page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter()
    if (!a) {
      return null
    }
    const i = a.info
    return {
      vendor: i.vendor,
      architecture: i.architecture,
      device: i.device,
      description: i.description,
      fallback:
        (i as { isFallbackAdapter?: boolean }).isFallbackAdapter === true
    }
  })
}

const adapterName = (r: RunInfo | undefined): string => {
  if (!r) {
    return 'unknown (no record)'
  }
  const a = r.adapter
  const name = a
    ? [a.vendor, a.architecture, a.description].filter(Boolean).join(' / ')
    : 'no adapter'
  return `${name}${r.software ? ' (software)' : ''}`
}

const major = (v: string): string => v.match(/(\d+)\./)?.[1] ?? v

/** Why `run` and `base` can't be compared on the GPU (null: they can), and
 * warnings that don't block the comparison. */
function mismatch(
  run: RunInfo,
  base: RunInfo | undefined
): { gpu: string | null; warn: string[] } {
  const warn: string[] = []
  if (!base) {
    // Unknown baseline adapter: a software run can't be checked against
    // it, so it gets CPU deltas only.
    return {
      gpu: run.software
        ? 'the baseline has no adapter record and this run is on a software adapter'
        : null,
      warn: [
        'the baseline has no adapter record (saved before the check existed): make sure it ran on the same GPU'
      ]
    }
  }
  let gpu: string | null = null
  if (run.software !== base.software) {
    gpu = `this run is on ${run.software ? 'a software' : 'a hardware'} adapter, the baseline on ${base.software ? 'a software' : 'a hardware'} one`
  } else if (
    run.adapter?.vendor !== base.adapter?.vendor ||
    run.adapter?.architecture !== base.adapter?.architecture
  ) {
    gpu = `adapters differ: ${adapterName(run)} vs ${adapterName(base)}`
  }
  if (major(run.browser) !== major(base.browser)) {
    warn.push(
      `browser versions differ: ${run.browser} vs ${base.browser} (layout and reads can move with it)`
    )
  }
  if (run.headed !== base.headed) {
    warn.push(
      `this run is ${run.headed ? 'headed' : 'headless'}, the baseline ${base.headed ? 'headed' : 'headless'}`
    )
  }
  return { gpu, warn }
}

async function requireActive(page: Page): Promise<void> {
  const state = await page.evaluate(async () => ({
    active: window.__gpu?.active === true,
    gpu: 'gpu' in navigator,
    adapter:
      'gpu' in navigator && (await navigator.gpu.requestAdapter()) !== null
  }))
  if (!state.active) {
    throw new Error(
      `[profile] the compositor is inactive: navigator.gpu ${state.gpu ? 'present' : 'missing'}, adapter ${state.adapter ? 'found' : 'none'}. ` +
        'Headed runs use installed Chrome (--channel chrome); try --channel chrome-canary, or open the page in your own Chrome and use __gpu.profile there.'
    )
  }
}

async function untilReady(page: Page, expr: string): Promise<void> {
  await page.waitForFunction(expr, null, { timeout: 60_000 })
}

/** Scroll a page top to bottom and back, `speed` px per frame. */
async function scrollPage(
  page: Page,
  speed: number
): Promise<ProfileReport | null> {
  return page.evaluate(async (speed) => {
    const gpu = window.__gpu
    if (!gpu) {
      return null
    }
    const raf = (): Promise<number> =>
      new Promise((r) => requestAnimationFrame(r))
    window.scrollTo(0, 0)
    await raf()
    await raf()
    gpu.profile.start()
    gpu.profile.mark('down')
    const max = (): number =>
      document.documentElement.scrollHeight - window.innerHeight
    while (window.scrollY < max() - 1) {
      window.scrollBy(0, speed)
      await raf()
    }
    gpu.profile.mark('up')
    while (window.scrollY > 0) {
      window.scrollBy(0, -speed)
      await raf()
    }
    return gpu.profile.stop()
  }, speed)
}

function delta(label: string, now: Pct, then: Pct | undefined): string {
  if (!then) {
    return ''
  }
  const d = (a: number, b: number): string => {
    const v = a - b
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
  }
  return `  ${label.padEnd(18)}p50 ${d(now.p50, then.p50).padStart(7)}  p95 ${d(now.p95, then.p95).padStart(7)}`
}

function compare(
  r: ProfileReport,
  base: ProfileReport,
  gpuOk: boolean
): string {
  if (!gpuOk) {
    // Frame pacing and GPU time describe the adapter: CPU only.
    return [
      '  vs baseline (CPU only: different adapter):',
      delta('cpu total', r.cpu.total, base.cpu.total),
      delta('  read', r.cpu.read, base.cpu.read)
    ]
      .filter(Boolean)
      .join('\n')
  }
  const lines = [
    `  vs baseline: late ${r.late - base.late >= 0 ? '+' : ''}${r.late - base.late}, dropped ${r.dropped - base.dropped >= 0 ? '+' : ''}${r.dropped - base.dropped}`,
    delta('frame interval', r.dt, base.dt),
    delta('cpu total', r.cpu.total, base.cpu.total),
    delta('  read', r.cpu.read, base.cpu.read)
  ]
  if (r.gpu && base.gpu) {
    lines.push(delta('gpu total', r.gpu.total, base.gpu.total))
  }
  return lines.filter(Boolean).join('\n')
}

async function main(): Promise<void> {
  const url = arg('url')
  const only = arg('only')?.split(',')
  const n = Number(arg('n') ?? 400)
  const speed = Number(arg('speed') ?? 12)
  const save = arg('save') ?? 'last'
  const baseline = arg('baseline')
  const frames = Number(arg('frames') ?? 1)
  const [vw, vh] = (arg('viewport') ?? '1280x900').split('x').map(Number)
  const outDir = resolve(here, 'out', save)
  mkdirSync(outDir, { recursive: true })

  let server: ViteDevServer | null = null
  let browser: Browser | null = null
  try {
    let base = url
    if (!base) {
      server = await createServer({
        configFile: resolve(root, 'vite.config.ts'),
        server: { port: 0, open: false, strictPort: false }
      })
      await server.listen()
      base = server.resolvedUrls?.local[0]
      if (!base) {
        throw new Error('vite dev server produced no resolved URL')
      }
    }
    let usedSwiftshader = false
    if (flag('headed')) {
      // Installed Chrome by default (Playwright's Chromium may come up
      // without a WebGPU adapter); `--channel chromium` for the bundled one.
      const channel = arg('channel') ?? 'chrome'
      const opts = {
        headless: false,
        args: ['--enable-unsafe-webgpu', ...GPU_TIMING_ARGS]
      }
      try {
        browser = await chromium.launch({
          ...opts,
          ...(process.env.CHROMIUM_PATH
            ? { executablePath: process.env.CHROMIUM_PATH }
            : channel === 'chromium'
              ? {}
              : { channel })
        })
      } catch (e) {
        console.log(
          `[profile] couldn't launch channel ${channel} (${(e as Error).message.split('\n')[0]}); using Playwright's Chromium`
        )
        browser = await chromium.launch(opts)
      }
      console.log(`[profile] headed: ${browser.version()}`)
    } else {
      const l = await launchWithFallback(base, 'profile', GPU_TIMING_ARGS)
      browser = l.browser
      usedSwiftshader = l.usedSwiftshader
    }
    const page = await browser.newPage({
      viewport: { width: vw || 1280, height: vh || 900 },
      deviceScaleFactor: Number(arg('dpr') ?? 1)
    })
    // tsx keeps function names with an __name() helper the page lacks.
    await page.addInitScript('globalThis.__name = (f) => f')
    page.on('pageerror', (e) => console.error('[page]', e.message))

    const hud = flag('hud') || (flag('headed') && !flag('no-hud'))
    const showHud = async (): Promise<void> => {
      if (hud) {
        await page.evaluate(() => window.__gpu?.profile.hud(true))
      }
    }
    const describeRun = async (): Promise<RunInfo> => {
      const adapter = await adapterInfo(page)
      const run: RunInfo = {
        adapter: adapter
          ? {
              vendor: adapter.vendor,
              architecture: adapter.architecture,
              device: adapter.device,
              description: adapter.description
            }
          : null,
        software:
          usedSwiftshader ||
          adapter?.fallback === true ||
          /swiftshader/i.test(
            `${adapter?.vendor} ${adapter?.architecture} ${adapter?.description}`
          ),
        browser: browser.version(),
        headed: flag('headed')
      }
      console.log(`[profile] adapter: ${adapterName(run)}, ${run.browser}`)
      if (run.software) {
        console.log(
          '[profile] ⚠ SOFTWARE ADAPTER: GPU times and frame pacing describe SwiftShader, not this machine (try --headed)'
        )
      }
      return run
    }
    const reports: [string, ProfileReport][] = []
    let run: RunInfo | null = null
    if (flag('explain')) {
      // A light page (perf.html takes seconds a frame on SwiftShader).
      await page.goto(`${base}layout.html?vr`, { waitUntil: 'load' })
      await untilReady(page, 'window.__gpu !== undefined')
      await requireActive(page)
      await page.evaluate(() => window.__gpu?.ready)
      await describeRun()
      await page.waitForTimeout(1000)
      const checks = await checkExplain(page)
      for (const c of checks) {
        console.log(`[explain] ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.note}`)
      }
      if (checks.some((c) => !c.ok)) {
        process.exitCode = 1
      }
      return
    }
    if (flag('morph')) {
      const count = Number(arg('morphs') ?? 20)
      const ms = Number(arg('ms') ?? 800)
      const results: MorphResult[] = []
      let open = ''
      for (const sc of MORPH_SCENARIOS) {
        if (only && !only.includes(sc.name)) {
          continue
        }
        if (open !== sc.page) {
          open = sc.page
          await page.goto(`${base}${sc.page}`, { waitUntil: 'load' })
          await untilReady(page, 'window.__gpu !== undefined')
          await requireActive(page)
          await page.evaluate(() => window.__gpu?.ready)
          run ??= await describeRun()
          await showHud()
          await page.waitForTimeout(1000)
        }
        console.log(`[profile] ${sc.name}`)
        const r = await recordMorph(page, sc, count, ms, 3000)
        if (!r) {
          console.log('[profile]   no report')
          continue
        }
        console.log(
          `[profile]   ${r.report.frames} frames, ${r.summary.frames} counted`
        )
        results.push(r)
        const saved: SavedReport = run ? { ...r.report, run } : r.report
        writeFileSync(resolve(outDir, `${sc.name}.json`), JSON.stringify(saved))
        console.log(formatReport(r.summary, `${sc.name} (counted frames)`))
        console.log('')
      }
      if (flag('diagnose')) {
        // Where the layout morph's GPU time goes, by the parts skipped.
        await page.goto(`${base}layout.html`, { waitUntil: 'load' })
        await untilReady(page, 'window.__gpu !== undefined')
        await page.evaluate(() => window.__gpu?.ready)
        run ??= await describeRun()
        await page.waitForTimeout(1000)
        console.log(
          `[profile] layout morph by part (${Math.min(count, 6)} swaps each)\n${await diagnoseLayout(page, Math.min(count, 6), ms)}\n`
        )
      }
      const v = verdict(results, run?.software ?? usedSwiftshader)
      console.log(`[profile] M5 budget (docs/EFFECTS.md, Q20)\n${v.table}`)
      console.log(`\n[profile] reports in ${outDir}`)
      if (!v.ok) {
        process.exitCode = 1
      }
      return
    }
    if (url) {
      await page.goto(url, { waitUntil: 'load' })
      await untilReady(page, 'window.__gpu !== undefined')
      await requireActive(page)
      run = await describeRun()
      await showHud()
      // Let fonts, images and entrance animations settle.
      await page.waitForTimeout(2000)
      const r = await scrollPage(page, speed)
      if (!r) {
        throw new Error('window.__gpu has no compositor')
      }
      reports.push(['page', r])
    } else {
      const cull =
        (flag('nocull') ? '&nocull' : '') +
        (flag('nodim') ? '&nodim' : '') +
        (flag('band') ? '&band' : '') +
        (flag('bandcanvas') ? '&bandcanvas' : '') +
        (flag('bandclear') ? '&bandclear' : '') +
        (flag('nopatch') ? '&nopatch' : '') +
        (flag('noatlas') ? '&noatlas' : '') +
        (flag('nopatchopacity') ? '&nopatchopacity' : '') +
        (flag('norefit') ? '&norefit' : '') +
        (flag('nostrips') ? '&nostrips' : '') +
        (flag('noskip') ? '&noskip' : '') +
        (flag('fixed') ? '&fixed' : '') +
        (arg('groups') ? `&groups=${arg('groups')}` : '') +
        (arg('ballast') ? `&ballast=${arg('ballast')}` : '')
      await page.goto(`${base}perf.html?n=${n}${cull}`, { waitUntil: 'load' })
      await untilReady(page, 'Boolean(window.__perf)')
      await page.evaluate(() => window.__perf?.ready)
      console.log(`[profile] perf.html n=${n} ready`)
      await requireActive(page)
      run = await describeRun()
      await showHud()
      for (const name of SCENARIOS) {
        if (only && !only.includes(name)) {
          continue
        }
        console.log(`[profile] ${name}`)
        const r = (await page.evaluate(
          ([name, frames]) => window.__perf?.scenario(name, frames) ?? null,
          [name, frames] as const
        )) as ProfileReport | null
        if (r) {
          console.log(`[profile]   ${r.frames} frames`)
          reports.push([name, r])
        } else {
          console.log('[profile]   no report')
        }
      }
    }

    console.log(
      `\n[profile] ${usedSwiftshader ? 'swiftshader (CPU numbers only)' : 'native GPU'}, ` +
        `GPU timing ${reports.some(([, r]) => r.gpuTiming) ? 'on' : 'unavailable'}\n`
    )
    let warned = false
    for (const [name, r] of reports) {
      const saved: SavedReport = run ? { ...r, run } : r
      writeFileSync(resolve(outDir, `${name}.json`), JSON.stringify(saved))
      console.log(formatReport(r, name))
      for (const ph of r.phases) {
        console.log(formatReport(ph.summary, `  ${name}/${ph.label}`))
      }
      if (baseline) {
        const file = resolve(here, 'out', baseline, `${name}.json`)
        if (existsSync(file)) {
          const b = JSON.parse(readFileSync(file, 'utf8')) as SavedReport
          const m = run
            ? mismatch(run, b.run)
            : { gpu: 'this run has no adapter record', warn: [] }
          if (!warned) {
            warned = true
            if (m.gpu) {
              console.log(
                `[profile] ⚠ baseline '${baseline}': ${m.gpu}; showing CPU deltas only`
              )
            }
            for (const w of m.warn) {
              console.log(`[profile] ⚠ baseline '${baseline}': ${w}`)
            }
          }
          console.log(compare(r, b, m.gpu === null))
        }
      }
      console.log('')
    }
    console.log(`[profile] reports in ${outDir}`)
    if (flag('headed') && flag('keep')) {
      console.log('[profile] window left open; close it to exit')
      await new Promise<void>((r) => browser?.once('disconnected', () => r()))
    }
  } finally {
    await browser?.close()
    await server?.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
