/// <reference path="../../playground/fx.d.ts" />
// Effects harness: loads playground/fx.html?vr (time and pointer pinned via
// fx.__override), captures each `section[data-vr]` GPU-only with its
// effect state, and diffs against local goldens (regression gate 0.5%;
// `--update` rewrites them; they are GPU-specific and gitignored).
//
//   fx-off            effects installed, none enabled
//   fx-tgpu           the fx-off section through a tgpu.fn fragment
//   fx-blur           blur enabled
//   fx-blur-scissor   blur enabled, compositor stopped, page scrolled half a
//                     viewport: the lower half shows canvas that was off the
//                     viewport when the chain ran, so it must be sharp
//   fx-displace       displace enabled
//   fx-blur-then-off  captured off, blur on (`-on`), then off again: the
//                     last capture must equal the first exactly
//
// Usage: npm run test:fx [-- --update] [-- --only fx-blur]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pixelmatch from 'pixelmatch'
import type { Browser, Page } from 'playwright'
import { PNG } from 'pngjs'
import { createServer, type ViteDevServer } from 'vite'
import { launchWithFallback } from '../lib/browser'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const outDir = resolve(here, 'out')
const goldenDir = resolve(here, 'golden')
mkdirSync(outDir, { recursive: true })
mkdirSync(goldenDir, { recursive: true })

const VW = 1280
const VH = 900

type Effect = 'none' | 'blur' | 'displace' | 'tgpu'

interface Result {
  name: string
  regressionPct: number | null
  status: 'ok' | 'fail' | 'missing' | 'no-golden' | 'updated'
  note?: string
}

const args = process.argv.slice(2)
const update = args.includes('--update')
const onlyIdx = args.indexOf('--only')
const only = onlyIdx === -1 ? null : (args[onlyIdx + 1] ?? null)

function diffPng(a: PNG, b: PNG, outPath: string): number {
  if (a.width !== b.width || a.height !== b.height) {
    return 100
  }
  const out = new PNG({ width: a.width, height: a.height })
  const n = pixelmatch(a.data, b.data, out.data, a.width, a.height, {
    threshold: 0.12,
    includeAA: true
  })
  writeFileSync(outPath, PNG.sync.write(out))
  return (n / (a.width * a.height)) * 100
}

/** Pixels whose RGBA differ at all. */
function exactDiff(a: PNG, b: PNG): number {
  if (a.width !== b.width || a.height !== b.height) {
    return Number.POSITIVE_INFINITY
  }
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2] ||
      a.data[i + 3] !== b.data[i + 3]
    ) {
      n++
    }
  }
  return n
}

async function setEffect(page: Page, effect: Effect): Promise<void> {
  await page.evaluate(async (e) => {
    const h = window.__fx
    if (!h) {
      return
    }
    h.blur.enabled = e === 'blur'
    h.displace.enabled = e === 'displace'
    h.tgpu.enabled = e === 'tgpu'
    await h.raf2()
    await h.raf2()
  }, effect)
}

function setMode(page: Page, mode: 'dom' | 'gpu' | 'both'): Promise<void> {
  return page.evaluate(async (m) => {
    await window.__fx?.setMode(m)
  }, mode)
}

async function sectionClip(
  page: Page,
  name: string
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const r = await page.evaluate((n) => {
    const el = document.querySelector(`section[data-vr="${n}"]`)
    if (!el) {
      return null
    }
    el.scrollIntoView({ behavior: 'instant', block: 'center' })
    const b = el.getBoundingClientRect()
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }
  }, name)
  if (!r) {
    return null
  }
  const x = Math.max(0, Math.floor(r.left))
  const y = Math.max(0, Math.floor(r.top))
  const width = Math.min(VW, Math.ceil(r.right)) - x
  const height = Math.min(VH, Math.ceil(r.bottom)) - y
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

async function shoot(
  page: Page,
  shot: string,
  clip: { x: number; y: number; width: number; height: number }
): Promise<PNG> {
  const path = resolve(outDir, `${shot}-gpu.png`)
  await page.screenshot({ path, clip })
  return PNG.sync.read(readFileSync(path))
}

function judge(shot: string, png: PNG): Result {
  const goldenPath = resolve(goldenDir, `${shot}.png`)
  if (update) {
    writeFileSync(goldenPath, PNG.sync.write(png))
    return { name: shot, regressionPct: null, status: 'updated' }
  }
  if (!existsSync(goldenPath)) {
    return { name: shot, regressionPct: null, status: 'no-golden' }
  }
  const golden = PNG.sync.read(readFileSync(goldenPath))
  const pct = diffPng(golden, png, resolve(outDir, `${shot}-golden-diff.png`))
  return { name: shot, regressionPct: pct, status: pct > 0.5 ? 'fail' : 'ok' }
}

async function main(): Promise<void> {
  let server: ViteDevServer | null = null
  let browser: Browser | null = null
  const results: Result[] = []
  const errors: string[] = []
  try {
    server = await createServer({
      configFile: resolve(root, 'vite.config.ts'),
      server: { port: 0, open: false, strictPort: false }
    })
    await server.listen()
    const url = server.resolvedUrls?.local[0]
    if (!url) {
      throw new Error('vite dev server produced no resolved URL')
    }
    console.log(`[fx] vite dev server at ${url}`)
    const launched = await launchWithFallback(url, 'fx')
    browser = launched.browser
    const page = await browser.newPage({
      viewport: { width: VW, height: VH },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce'
    })
    page.on('console', (m) => {
      // Shader, validation and runtime errors; not resource loads (the
      // dev server's 404s and dep re-optimisation).
      if (m.type() === 'error' && m.text().includes('[compositor-gpu]')) {
        errors.push(m.text())
      }
    })
    await page.goto(`${url}fx.html?vr`, { waitUntil: 'load' })
    await page.waitForFunction(() => Boolean(window.__fx), null, {
      timeout: 30_000
    })
    await page.evaluate(() => window.__fx?.ready)
    const stats = await page.evaluate(() => window.__fx?.stats())
    if (!stats?.active) {
      throw new Error('[fx] compositor inactive — WebGPU did not start')
    }
    console.log(
      `[fx] compositor active (${launched.usedSwiftshader ? 'swiftshader' : 'native'}) — boxes=${stats.boxes} glyphs=${stats.glyphs} images=${stats.images}`
    )

    const want = (n: string): boolean => !only || n === only

    const capture = async (
      section: string,
      shot: string,
      effect: Effect
    ): Promise<PNG | null> => {
      const clip = await sectionClip(page, section)
      if (!clip) {
        results.push({ name: shot, regressionPct: null, status: 'missing' })
        return null
      }
      await setEffect(page, effect)
      await setMode(page, 'gpu')
      const png = await shoot(page, shot, clip)
      await setMode(page, 'both')
      results.push(judge(shot, png))
      return png
    }

    if (want('fx-off')) {
      await capture('fx-off', 'fx-off', 'none')
    }
    if (want('fx-tgpu')) {
      await capture('fx-off', 'fx-tgpu', 'tgpu')
    }
    if (want('fx-blur')) {
      await capture('fx-blur', 'fx-blur', 'blur')
    }
    if (want('fx-blur-scissor')) {
      // Render blurred at this scroll, freeze the loop, scroll half a
      // viewport: the canvas below the old viewport (+ radius) must be
      // the unblurred scene.
      await sectionClip(page, 'fx-blur')
      await setEffect(page, 'blur')
      await setMode(page, 'gpu')
      await page.evaluate(() => window.__fx?.stop())
      await setMode(page, 'gpu')
      await page.evaluate((y) => window.scrollBy(0, y), VH / 2)
      await page.evaluate(() => window.__fx?.raf2())
      const png = await shoot(page, 'fx-blur-scissor', {
        x: 0,
        y: 0,
        width: VW,
        height: VH
      })
      await page.evaluate(() => window.__fx?.start())
      await setMode(page, 'both')
      results.push(judge('fx-blur-scissor', png))
    }
    if (want('fx-displace')) {
      await capture('fx-displace', 'fx-displace', 'displace')
    }
    if (want('fx-blur-then-off')) {
      const s = 'fx-blur-then-off'
      const pre = await capture(s, `${s}-pre`, 'none')
      await capture(s, `${s}-on`, 'blur')
      const post = await capture(s, s, 'none')
      if (pre && post) {
        const n = exactDiff(pre, post)
        const pct = diffPng(pre, post, resolve(outDir, `${s}-invariant.png`))
        results.push({
          name: `${s} (= pre)`,
          regressionPct: pct,
          status: n === 0 ? 'ok' : 'fail',
          note: `${n} px differ`
        })
      }
    }
    await setEffect(page, 'none')
    if (errors.length > 0) {
      console.log(`\n[fx] console errors:\n  ${errors.join('\n  ')}`)
    }
  } finally {
    await browser?.close()
    await server?.close()
  }

  const fmt = (n: number | null): string => (n === null ? '   -' : n.toFixed(2))
  console.log('\nsection                   regression%  status')
  console.log('---------------------------------------------')
  for (const r of results) {
    console.log(
      `${r.name.padEnd(25)} ${fmt(r.regressionPct).padStart(11)}  ${r.status}${r.note ? `  (${r.note})` : ''}`
    )
  }
  if (
    errors.length > 0 ||
    results.some((r) => r.status === 'fail' || r.status === 'missing')
  ) {
    console.error('\n[fx] FAILED')
    process.exit(1)
  }
  console.log('\n[fx] OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
