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
//   --headed   a visible window (the real GPU and display refresh)
//   --frames 0.25   scale each scenario's frame count
//   --viewport 1280x900
//
// SwiftShader (no GPU) numbers only mean something for the CPU columns.
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

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

export const SCENARIOS = [
  'idle',
  'scroll',
  'mutate',
  'full-read',
  'css-transforms',
  'fx-transforms',
  'reveal',
  'blur-scroll'
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

function compare(r: ProfileReport, base: ProfileReport): string {
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
      browser = await chromium.launch({
        headless: false,
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: GPU_TIMING_ARGS
      })
    } else {
      const l = await launchWithFallback(base, 'profile', GPU_TIMING_ARGS)
      browser = l.browser
      usedSwiftshader = l.usedSwiftshader
    }
    const page = await browser.newPage({
      viewport: { width: vw || 1280, height: vh || 900 },
      deviceScaleFactor: 1
    })
    // tsx keeps function names with an __name() helper the page lacks.
    await page.addInitScript('globalThis.__name = (f) => f')
    page.on('pageerror', (e) => console.error('[page]', e.message))

    const reports: [string, ProfileReport][] = []
    if (url) {
      await page.goto(url, { waitUntil: 'load' })
      await untilReady(page, 'window.__gpu?.active === true')
      // Let fonts, images and entrance animations settle.
      await page.waitForTimeout(2000)
      const r = await scrollPage(page, speed)
      if (!r) {
        throw new Error('window.__gpu has no compositor')
      }
      reports.push(['page', r])
    } else {
      await page.goto(`${base}perf.html?n=${n}`, { waitUntil: 'load' })
      await untilReady(page, 'Boolean(window.__perf)')
      await page.evaluate(() => window.__perf?.ready)
      console.log(`[profile] perf.html n=${n} ready`)
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
          reports.push([name, r])
        }
      }
    }

    console.log(
      `\n[profile] ${usedSwiftshader ? 'swiftshader (CPU numbers only)' : 'native GPU'}, ` +
        `GPU timing ${reports.some(([, r]) => r.gpuTiming) ? 'on' : 'unavailable'}\n`
    )
    for (const [name, r] of reports) {
      writeFileSync(resolve(outDir, `${name}.json`), JSON.stringify(r))
      console.log(formatReport(r, name))
      for (const ph of r.phases) {
        console.log(formatReport(ph.summary, `  ${name}/${ph.label}`))
      }
      if (baseline) {
        const file = resolve(here, 'out', baseline, `${name}.json`)
        if (existsSync(file)) {
          const b = JSON.parse(readFileSync(file, 'utf8')) as ProfileReport
          console.log(compare(r, b))
        }
      }
      console.log('')
    }
    console.log(`[profile] reports in ${outDir}`)
  } finally {
    await browser?.close()
    await server?.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
