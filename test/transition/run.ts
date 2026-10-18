/// <reference path="../../playground/transition.d.ts" />
// Transition harness: runs playground/transition.html?auto (N swaps
// between two page states under fx.transition, each revealed over `--ms`)
// in headed Chrome and prints how long capture() and settled() waited,
// how many progress frames showed the source DOM, and the profiler's
// summary of the progress frames (pacing, GPU time).
//
//   npx tsx test/transition/run.ts [--n 20] [--ms 600] [--dpr 2]
//     [--viewport 1280x900] [--channel chrome]
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import { formatReport } from '../../src/profile/profiler'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2)
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] ?? 0
}

async function main(): Promise<void> {
  const n = Number(arg('n') ?? 20)
  const ms = Number(arg('ms') ?? 600)
  const [vw, vh] = (arg('viewport') ?? '1280x900').split('x').map(Number)
  let server: ViteDevServer | null = null
  let browser: Browser | null = null
  try {
    server = await createServer({
      configFile: resolve(root, 'vite.config.ts'),
      server: { port: 0, open: false, strictPort: false }
    })
    await server.listen()
    const base = server.resolvedUrls?.local[0]
    if (!base) {
      throw new Error('vite dev server produced no resolved URL')
    }
    const channel = arg('channel') ?? 'chrome'
    browser = await chromium.launch({
      headless: false,
      args: ['--enable-unsafe-webgpu', '--enable-webgpu-developer-features'],
      ...(channel === 'chromium' ? {} : { channel })
    })
    console.log(`[transition] headed: ${browser.version()}`)
    const page = await browser.newPage({
      viewport: { width: vw || 1280, height: vh || 900 },
      deviceScaleFactor: Number(arg('dpr') ?? 1)
    })
    await page.addInitScript('globalThis.__name = (f) => f')
    page.on('pageerror', (e) => console.error('[page]', e.message))
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') {
        console.log(`[page:${m.type()}]`, m.text())
      }
    })
    await page.goto(`${base}transition.html?auto&n=${n}&ms=${ms}`)
    await page.waitForFunction(() => window.__tr?.done === true, null, {
      timeout: 60_000 + n * (ms + 3000)
    })
    const out = await page.evaluate(() => {
      const t = window.__tr
      return {
        results: t?.results ?? [],
        shown: t?.shown ?? -1,
        summary: t?.summary ?? null
      }
    })
    const cap = out.results.map((r) => r.captureMs)
    const set = out.results.map((r) => r.settleMs)
    const line = (label: string, xs: number[]): string =>
      `${label} p50 ${pct(xs, 0.5).toFixed(1)} / p95 ${pct(xs, 0.95).toFixed(1)} / max ${Math.max(...xs).toFixed(1)} ms`
    console.log(`[transition] ${out.results.length} transitions, ${ms} ms each`)
    console.log(`[transition] ${line('capture()', cap)}`)
    console.log(`[transition] ${line('settled()', set)}`)
    console.log(`[transition] frames showing the source DOM: ${out.shown}`)
    if (out.summary) {
      console.log(formatReport(out.summary, 'progress frames'))
    }
  } finally {
    await browser?.close()
    await server?.close()
  }
}

await main()
