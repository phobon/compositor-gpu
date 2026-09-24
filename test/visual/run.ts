/// <reference path="../../playground/vr.d.ts" />
// Visual-regression harness: for each `[data-vr]` demo section in the
// playground, captures the DOM paint and the GPU-mirrored paint and diffs
// them (`parity`, informational — Slug's AA differs from the browser's), and
// diffs the GPU capture against a checked-out-locally golden (`regression`,
// gating). Goldens are GPU-specific so they live outside git (see
// .gitignore) and are (re)created with `--update`.
//
// Usage:
//   npm run test:visual -- --update       # (re)write goldens
//   npm run test:visual                   # check against goldens
//   npm run test:visual -- --only boxes
//   npm run test:visual -- --parity-max 5
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pixelmatch from 'pixelmatch'
import { type Browser, type Page, chromium } from 'playwright'
import { PNG } from 'pngjs'
import { type ViteDevServer, createServer } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const outDir = resolve(here, 'out')
const goldenDir = resolve(here, 'golden')
mkdirSync(outDir, { recursive: true })
mkdirSync(goldenDir, { recursive: true })

const SECTIONS = [
  'text',
  'decorations',
  'emoji',
  'boxes',
  'shadows',
  'images',
  'gradients',
  'overflow',
  'stacking',
  'opacity',
  'transforms',
  'mutations',
  'canvas'
] as const

const SWIFTSHADER_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=swiftshader',
  '--use-vulkan=swiftshader',
  '--ignore-gpu-blocklist'
]

interface Args {
  update: boolean
  only: string | null
  parityMax: number | null
}

function parseArgs(argv: string[]): Args {
  let only: string | null = null
  let parityMax: number | null = null
  const update = argv.includes('--update')
  const onlyIdx = argv.indexOf('--only')
  if (onlyIdx !== -1) only = argv[onlyIdx + 1] ?? null
  const pmIdx = argv.indexOf('--parity-max')
  if (pmIdx !== -1) {
    const v = argv[pmIdx + 1]
    if (v) parityMax = Number(v)
  }
  return { update, only, parityMax }
}

function readPng(path: string): PNG {
  return PNG.sync.read(readFileSync(path))
}

function writePng(path: string, png: PNG): void {
  writeFileSync(path, PNG.sync.write(png))
}

/** Mismatch percentage between two same-size PNGs, writing a diff image. */
function diff(aPath: string, bPath: string, outPath: string): number {
  const a = readPng(aPath)
  const b = readPng(bPath)
  const { width, height } = a
  if (b.width !== width || b.height !== height) {
    throw new Error(
      `size mismatch comparing ${aPath} (${width}x${height}) vs ` +
        `${bPath} (${b.width}x${b.height})`
    )
  }
  const out = new PNG({ width, height })
  const mismatched = pixelmatch(a.data, b.data, out.data, width, height, {
    threshold: 0.12,
    includeAA: true
  })
  writePng(outPath, out)
  return (mismatched / (width * height)) * 100
}

function setMode(page: Page, mode: 'dom' | 'gpu' | 'both'): Promise<void> {
  return page.evaluate<void, 'dom' | 'gpu' | 'both'>(async (m) => {
    await window.__vr?.setMode(m)
  }, mode)
}

async function waitForAdapter(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    if (!navigator.gpu) return false
    const adapter = await navigator.gpu.requestAdapter()
    return adapter !== null
  })
}

async function launchWithFallback(url: string): Promise<{
  browser: Browser
  usedSwiftshader: boolean
}> {
  const executablePath = process.env.CHROMIUM_PATH || undefined
  const launchOpts = { executablePath } as const

  const probe = await chromium.launch({ ...launchOpts, args: [] })
  try {
    const page = await probe.newPage()
    // Needs a secure context, so probe against the real dev-server origin
    // rather than about:blank.
    await page.goto(url)
    const hasAdapter = await waitForAdapter(page)
    await page.close()
    if (hasAdapter) {
      console.log('[visual] using native GPU adapter (no swiftshader args)')
      return { browser: probe, usedSwiftshader: false }
    }
  } catch (e) {
    console.log('[visual] native GPU probe failed:', (e as Error).message)
  }
  await probe.close()

  console.log('[visual] falling back to swiftshader (software WebGPU)')
  const browser = await chromium.launch({
    ...launchOpts,
    args: SWIFTSHADER_ARGS
  })
  return { browser, usedSwiftshader: true }
}

interface SectionResult {
  name: string
  parityPct: number | null
  regressionPct: number | null
  status: 'ok' | 'fail' | 'missing' | 'no-golden'
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const sections = args.only
    ? SECTIONS.filter((s) => s === args.only)
    : SECTIONS
  if (args.only && sections.length === 0) {
    throw new Error(`--only ${args.only}: no such section`)
  }

  let server: ViteDevServer | null = null
  let browser: Browser | null = null
  const results: SectionResult[] = []
  let hadFailure = false

  try {
    server = await createServer({
      configFile: resolve(root, 'vite.config.ts'),
      server: { port: 0, open: false, strictPort: false }
    })
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    if (!url) throw new Error('vite dev server produced no resolved URL')
    console.log(`[visual] vite dev server at ${url}`)

    const { browser: b, usedSwiftshader } = await launchWithFallback(url)
    browser = b
    console.log(
      `[visual] chromium launched (${usedSwiftshader ? 'swiftshader' : 'native'})`
    )

    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce'
    })

    await page.goto(`${url}?vr`, { waitUntil: 'load' })
    await page.waitForFunction(() => Boolean(window.__vr), null, {
      timeout: 30_000
    })
    try {
      await page.evaluate(
        () =>
          new Promise<void>((resolvePromise, reject) => {
            const timeout = setTimeout(
              () => reject(new Error('window.__vr.ready timed out')),
              30_000
            )
            window.__vr?.ready.then(() => {
              clearTimeout(timeout)
              resolvePromise()
            }, reject)
          })
      )
    } catch (e) {
      throw new Error(
        `[visual] playground never became ready (window.__vr.ready): ${(e as Error).message}`
      )
    }

    const stats = await page.evaluate(() => window.__vr?.stats())
    if (!stats?.active) {
      throw new Error(
        '[visual] compositor.stats().active is false — WebGPU did not ' +
          'activate in this browser; check the launch args / adapter.'
      )
    }
    console.log(
      `[visual] compositor active — boxes=${stats.boxes} glyphs=${stats.glyphs} images=${stats.images}`
    )

    for (const name of sections) {
      const selector = `section[data-vr="${name}"]`
      const handle = await page.$(selector)
      if (!handle) {
        console.error(`[visual] MISSING section ${selector}`)
        results.push({
          name,
          parityPct: null,
          regressionPct: null,
          status: 'missing'
        })
        hadFailure = true
        continue
      }

      await handle.evaluate((el) =>
        el.scrollIntoView({ behavior: 'instant', block: 'center' })
      )
      await page.evaluate(
        () =>
          new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r()))
          )
      )

      const rect = await handle.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      })

      const vw = 1280
      const vh = 900
      const left = Math.max(0, Math.floor(rect.left))
      const top = Math.max(0, Math.floor(rect.top))
      const right = Math.min(vw, Math.ceil(rect.right))
      const bottom = Math.min(vh, Math.ceil(rect.bottom))
      const width = right - left
      const height = bottom - top
      if (width <= 0 || height <= 0) {
        console.error(`[visual] MISSING/empty section ${selector} (offscreen)`)
        results.push({
          name,
          parityPct: null,
          regressionPct: null,
          status: 'missing'
        })
        hadFailure = true
        continue
      }
      const clipBox = { x: left, y: top, width, height }

      await setMode(page, 'dom')
      const domPath = resolve(outDir, `${name}-dom.png`)
      await page.screenshot({ path: domPath, clip: clipBox })

      await setMode(page, 'gpu')
      const gpuPath = resolve(outDir, `${name}-gpu.png`)
      await page.screenshot({ path: gpuPath, clip: clipBox })

      // Restore overlay mode between sections for a consistent starting state.
      await setMode(page, 'both')

      const parityDiffPath = resolve(outDir, `${name}-parity-diff.png`)
      const parityPct = diff(domPath, gpuPath, parityDiffPath)

      const goldenPath = resolve(goldenDir, `${name}.png`)
      let regressionPct: number | null = null
      let status: SectionResult['status'] = 'ok'

      if (args.update) {
        writeFileSync(goldenPath, readFileSync(gpuPath))
        status = 'ok'
      } else if (existsSync(goldenPath)) {
        const goldenDiffPath = resolve(outDir, `${name}-golden-diff.png`)
        regressionPct = diff(goldenPath, gpuPath, goldenDiffPath)
        if (regressionPct > 0.5) {
          status = 'fail'
          hadFailure = true
        }
      } else {
        status = 'no-golden'
      }

      if (
        status === 'ok' &&
        args.parityMax !== null &&
        parityPct > args.parityMax
      ) {
        status = 'fail'
        hadFailure = true
      }

      results.push({ name, parityPct, regressionPct, status })
    }
  } finally {
    await browser?.close()
    await server?.close()
  }

  printTable(results)

  if (hadFailure) {
    console.error('\n[visual] FAILED')
    process.exit(1)
  }
  console.log('\n[visual] OK')
}

function printTable(results: SectionResult[]): void {
  const fmt = (n: number | null): string => (n === null ? '   -' : n.toFixed(2))
  console.log('\nsection      parity%  regression%  status')
  console.log('------------------------------------------')
  for (const r of results) {
    console.log(
      `${r.name.padEnd(12)} ${fmt(r.parityPct).padStart(7)}  ${fmt(r.regressionPct).padStart(11)}  ${r.status}`
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
