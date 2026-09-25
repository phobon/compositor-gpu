/// <reference path="./site.d.ts" />
/// <reference path="../../playground/vr.d.ts" />
// DOM-vs-GPU parity on an arbitrary real page: builds a self-contained bundle
// of the library, injects it into `--url` (or the playground, by default),
// mounts a compositor over the live page, and diffs DOM-only vs GPU-only
// screenshots at each of `--scroll`'s offsets.
//
// Usage:
//   npm run test:site                                   # against the playground
//   npm run test:site -- --url https://example.com
//   npm run test:site -- --url <playground url>?vr --scroll 0,800
//   npm run test:site -- --root "#app" --only-layers boxes,text
//   npm run test:site -- --replace                       # mode:'replace' capture
//   npm run test:site -- --bundle-url                     # page already mounts
//                                                          # itself; expects
//                                                          # window.__site
//   npm run test:site -- --parity-max 8                   # gate (optional)
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pixelmatch from 'pixelmatch'
import type { Browser, Page } from 'playwright'
import { PNG } from 'pngjs'
import { build, createServer, type ViteDevServer } from 'vite'
import { launchWithFallback } from '../lib/browser'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const outDir = resolve(here, 'out')
mkdirSync(outDir, { recursive: true })

interface Args {
  url: string | null
  width: number
  height: number
  scroll: number[]
  root: string
  onlyLayers: string[] | null
  replace: boolean
  bundleUrl: boolean
  parityMax: number | null
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const idx = argv.indexOf(flag)
    return idx === -1 ? null : (argv[idx + 1] ?? null)
  }
  const num = (flag: string, dflt: number): number => {
    const v = get(flag)
    const n = v ? Number(v) : Number.NaN
    return Number.isFinite(n) ? n : dflt
  }
  const scrollRaw = get('--scroll') ?? '0,600,1200'
  const scroll = scrollRaw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
  const onlyLayersRaw = get('--only-layers')
  return {
    url: get('--url'),
    width: num('--width', 1280),
    height: num('--height', 900),
    scroll: scroll.length > 0 ? scroll : [0, 600, 1200],
    root: get('--root') ?? 'body',
    onlyLayers: onlyLayersRaw
      ? onlyLayersRaw.split(',').map((s) => s.trim())
      : null,
    replace: argv.includes('--replace'),
    bundleUrl: argv.includes('--bundle-url'),
    parityMax: (() => {
      const v = get('--parity-max')
      return v ? Number(v) : null
    })()
  }
}

// --- bundle for injection ---------------------------------------------

const BUNDLE_ROUTE = '/__compositor-gpu-inject__.js'

function newestMtimeMs(dir: string): number {
  let max = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name)
    max = Math.max(
      max,
      entry.isDirectory() ? newestMtimeMs(p) : statSync(p).mtimeMs
    )
  }
  return max
}

/** A self-contained ES-module build of `src/index.ts` (typegpu and
 * opentype.js bundled in, unlike the library build's externals) — an
 * injected page needs no other script tags to resolve it. Cached by mtime:
 * rebuilt only when a file under `src/` is newer than the last bundle. */
async function ensureInjectBundle(): Promise<string> {
  const bundlePath = resolve(outDir, 'compositor-gpu.inject.js')
  const srcMtime = newestMtimeMs(resolve(root, 'src'))
  if (existsSync(bundlePath) && statSync(bundlePath).mtimeMs > srcMtime) {
    console.log(`[site] using cached inject bundle (${bundlePath})`)
    return bundlePath
  }
  console.log('[site] building self-contained inject bundle...')
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    resolve: { alias: { '@': resolve(root, 'src') } },
    // typegpu reads `globalThis.process.env.NODE_ENV` directly (not the bare
    // `process.env.NODE_ENV` Vite's own define matches) — bundled in for
    // injection, that throws on a page with no Node `process` global.
    define: {
      'globalThis.process.env.NODE_ENV': JSON.stringify('production'),
      'process.env.NODE_ENV': JSON.stringify('production')
    },
    build: {
      lib: {
        entry: resolve(root, 'src/index.ts'),
        formats: ['es'],
        fileName: () => 'compositor-gpu.inject.js'
      },
      outDir,
      emptyOutDir: false,
      rollupOptions: { external: [] },
      sourcemap: false,
      target: 'esnext'
    }
  })
  return bundlePath
}

/** Route `BUNDLE_ROUTE` on `page` to the built bundle (same-origin, so a
 * default `script-src 'self'` CSP still allows it) and load it as a module,
 * exposing `createCompositor` on `window`. */
async function injectBundle(page: Page, bundlePath: string): Promise<void> {
  await page.route(`**${BUNDLE_ROUTE}`, (route) =>
    route.fulfill({ path: bundlePath, contentType: 'text/javascript' })
  )
  await page.addScriptTag({
    type: 'module',
    content: `
      const mod = await import(${JSON.stringify(BUNDLE_ROUTE)})
      window.__createCompositor = mod.createCompositor
    `
  })
  await page.waitForFunction(() => Boolean(window.__createCompositor), null, {
    timeout: 30_000
  })
}

// --- page helpers -------------------------------------------------------

/**
 * Real pages lazy-load and cross-fade images as they scroll into view
 * (gatsby-plugin-image, IntersectionObserver reveals); capturing DOM and
 * GPU a frame apart mid-transition reports false mismatches. Wait until
 * every animation has stopped and every visible <img> is decoded, then two
 * more frames so the compositor's transition tracking has re-read.
 */
async function settle(page: Page, timeoutMs = 5000): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const running = document
          .getAnimations()
          .some((a) => a.playState === 'running')
        if (running) {
          return false
        }
        const h = window.innerHeight
        for (const img of document.images) {
          const r = img.getBoundingClientRect()
          if (r.bottom < 0 || r.top > h || r.width === 0) {
            continue
          }
          if (!img.complete) {
            return false
          }
        }
        return true
      },
      null,
      { timeout: timeoutMs }
    )
    .catch(() => undefined)
  await raf2(page)
  await raf2(page)
}

/** Fingerprint of what could change a screenshot without a scroll. */
function pageStateKey(page: Page): Promise<string> {
  return page.evaluate(() => {
    const h = window.innerHeight
    const parts: string[] = [String(document.getAnimations().length)]
    for (const img of document.images) {
      const r = img.getBoundingClientRect()
      if (r.bottom < 0 || r.top > h || r.width === 0) {
        continue
      }
      parts.push(
        `${img.currentSrc}|${img.complete}|${getComputedStyle(img).opacity}`
      )
    }
    return parts.join('\n')
  })
}

function raf2(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r()))
      )
  )
}

/** Wait for `window.__site.stats().active` and `text.ready`, throwing a
 * message that includes whatever stats snapshot is available on timeout. */
async function waitForSiteReady(page: Page, timeoutMs = 30_000): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const s = window.__site
        if (!s) {
          return false
        }
        const stats = s.stats()
        // A page with no @font-face rules has no Slug faces: text goes
        // through the fallback atlas and `ready` never flips. Don't wait.
        const noFaces =
          stats.faces === 0 && (s.text?.failedFaces?.length ?? 0) === 0
        return stats.active && (!s.text || s.text.ready || noFaces)
      },
      null,
      { timeout: timeoutMs }
    )
  } catch (e) {
    const snap = await page
      .evaluate(() => {
        const s = window.__site
        return s ? { stats: s.stats(), textReady: s.text?.ready ?? null } : null
      })
      .catch(() => null)
    throw new Error(
      `[site] compositor never became ready within ${timeoutMs}ms ` +
        `(stats().active && text.ready) — snapshot: ${JSON.stringify(snap)}. ` +
        `Original error: ${(e as Error).message}`
    )
  }
}

interface SiteStats {
  active: boolean
  boxes: number
  images: number
  glyphs: number
  fallback: number
  ligatures: number
  faces: number
  uploads: number
  batches: number
  draws: number
  groups: number
  readElements: number
  partialReads: number
  readMs: number
  uploadMs: number
  encodeMs: number
  fps: number
}

interface OffsetResult {
  y: number
  parityPct: number
  stats: SiteStats
}

/** Mismatch percentage between two same-size PNGs, writing a diff image. */
function diffPngs(aPath: string, bPath: string, outPath: string): number {
  const a = PNG.sync.read(readFileSync(aPath))
  const b = PNG.sync.read(readFileSync(bPath))
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
  writeFileSync(outPath, PNG.sync.write(out))
  return (mismatched / (width * height)) * 100
}

/** Scroll to `y`, capture DOM-only then GPU-only full-viewport screenshots,
 * and diff them. */
async function captureOffset(
  page: Page,
  y: number,
  slug: string
): Promise<OffsetResult> {
  await page.evaluate((y) => window.scrollTo(0, y), y)
  await raf2(page)

  const domPath = resolve(outDir, `${slug}-${y}-dom.png`)
  const gpuPath = resolve(outDir, `${slug}-${y}-gpu.png`)
  // Lazy images and reveal transitions can change the page between the two
  // screenshots; capture both, then confirm the page's visible state didn't
  // change across them, else settle again and recapture (up to 3 tries).
  for (let attempt = 0; attempt < 3; attempt++) {
    await settle(page)
    const before = await pageStateKey(page)
    await page.evaluate(() => {
      window.__site?.setSourceHidden(false)
      const cv = window.__site?.canvas
      if (cv) {
        cv.style.visibility = 'hidden'
      }
    })
    await raf2(page)
    await page.screenshot({ path: domPath })

    await page.evaluate(() => {
      window.__site?.setSourceHidden(true)
      const cv = window.__site?.canvas
      if (cv) {
        cv.style.visibility = 'visible'
      }
    })
    await raf2(page)
    await page.screenshot({ path: gpuPath })
    const after = await pageStateKey(page)
    if (before === after) {
      break
    }
    console.log(`[site] page changed during capture at ${y}px — retrying`)
  }

  // Restore a normal-looking page for the next offset / for a human
  // re-checking the page interactively.
  await page.evaluate(() => {
    window.__site?.setSourceHidden(false)
    const cv = window.__site?.canvas
    if (cv) {
      cv.style.visibility = 'visible'
    }
  })

  const diffPath = resolve(outDir, `${slug}-${y}-diff.png`)
  const parityPct = diffPngs(domPath, gpuPath, diffPath)
  const stats = (await page.evaluate(() => window.__site?.stats())) as SiteStats
  return { y, parityPct, stats }
}

function slugify(url: string): string {
  let raw: string
  try {
    const u = new URL(url)
    raw = `${u.hostname}${u.pathname}`
  } catch {
    raw = url
  }
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'site'
  )
}

function printTable(results: OffsetResult[]): void {
  console.log(
    '\noffset  parity%  boxes  glyphs  images  fallback  liga  batches  draws  groups  readMs'
  )
  console.log('-'.repeat(92))
  for (const r of results) {
    const s = r.stats
    console.log(
      `${String(r.y).padEnd(6)}  ${r.parityPct.toFixed(2).padStart(6)}  ` +
        `${String(s.boxes).padStart(5)}  ${String(s.glyphs).padStart(6)}  ` +
        `${String(s.images).padStart(6)}  ${String(s.fallback).padStart(8)}  ` +
        `${String(s.ligatures).padStart(4)}  ${String(s.batches).padStart(7)}  ` +
        `${String(s.draws).padStart(5)}  ${String(s.groups).padStart(6)}  ` +
        `${s.readMs.toFixed(2).padStart(6)}`
    )
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  let devServer: ViteDevServer | null = null
  let browser: Browser | null = null
  const consoleIssues: string[] = []

  try {
    let targetUrl = args.url
    if (!targetUrl) {
      devServer = await createServer({
        configFile: resolve(root, 'vite.config.ts'),
        server: { port: 0, open: false, strictPort: false }
      })
      await devServer.listen()
      const url = devServer.resolvedUrls?.local[0]
      if (!url) {
        throw new Error('vite dev server produced no resolved URL')
      }
      // The playground exposes deterministic `?vr` mode for exactly this
      // kind of automated capture (no glyph animation, frozen live canvas).
      targetUrl = `${url}?vr`
      console.log(`[site] no --url given — using the playground at ${url}`)
    }

    const { browser: b, usedSwiftshader } = await launchWithFallback(
      targetUrl,
      'site'
    )
    browser = b
    console.log(
      `[site] chromium launched (${usedSwiftshader ? 'swiftshader' : 'native'})`
    )

    const page = await browser.newPage({
      viewport: { width: args.width, height: args.height },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce'
    })
    page.on('console', (msg) => {
      const t = msg.type()
      if (t === 'error' || t === 'warning') {
        consoleIssues.push(`[console.${t}] ${msg.text()}`)
      }
    })
    page.on('pageerror', (err) => {
      consoleIssues.push(`[pageerror] ${err.message}`)
    })

    console.log(`[site] navigating to ${targetUrl}`)
    await page.goto(targetUrl, { waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts.ready)
    await raf2(page)

    // Testing the playground itself: it already mounts its own compositor
    // (`window.__vr`). Let it finish, then hide its overlay canvas so our
    // injected instance is the only GPU layer painting the page.
    const hasPlaygroundVr = await page
      .evaluate(() => Boolean(window.__vr))
      .catch(() => false)
    if (hasPlaygroundVr) {
      console.log(
        '[site] target is the playground (window.__vr present) — muting its own overlay'
      )
      await page.evaluate(() => window.__vr?.ready).catch(() => undefined)
      await page.evaluate(() => window.__vr?.setMode('dom'))
    }

    if (args.bundleUrl) {
      console.log(
        '[site] --bundle-url: skipping injection, expecting window.__site'
      )
    } else {
      const bundlePath = await ensureInjectBundle()
      await injectBundle(page, bundlePath)
      await page.evaluate(
        async ({ rootSel, mode, layers }) => {
          const found = document.querySelector(rootSel)
          const mountRoot = found instanceof HTMLElement ? found : document.body
          const create = window.__createCompositor
          if (!create) {
            throw new Error('inject bundle did not expose createCompositor')
          }
          const options: Record<string, unknown> = {
            root: mountRoot,
            mode,
            fonts: 'auto'
          }
          if (layers) {
            options.layers = layers
          }
          const site = await create(options)
          window.__site = site
          site.start()
        },
        {
          rootSel: args.root,
          mode: args.replace ? 'replace' : 'overlay',
          layers: args.onlyLayers
        }
      )
    }

    await waitForSiteReady(page)
    await raf2(page)

    const failedFaces = (await page.evaluate(
      () => window.__site?.text?.failedFaces ?? []
    )) as string[]
    if (failedFaces.length > 0) {
      console.warn(
        `[site] faces that failed to resolve (drawn via the Canvas 2D fallback atlas instead): ${failedFaces.join(', ')}`
      )
    }

    const pageHeight = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    )
    const offsets = [
      ...new Set(args.scroll.map((y) => clamp(y, 0, pageHeight)))
    ]

    const slug = slugify(targetUrl)
    const results: OffsetResult[] = []
    for (const y of offsets) {
      results.push(await captureOffset(page, y, slug))
    }

    printTable(results)

    const finalStats = (await page.evaluate(() => window.__site?.stats())) as
      | SiteStats
      | undefined

    console.log('\n--- summary ---')
    const dedupedIssues = [...new Set(consoleIssues)]
    if (dedupedIssues.length === 0) {
      console.log('console: no errors or warnings')
    } else {
      console.log(`console (${dedupedIssues.length} unique):`)
      for (const issue of dedupedIssues) {
        console.log(`  ${issue}`)
      }
    }
    console.log(
      `failed faces: ${failedFaces.length === 0 ? 'none' : failedFaces.join(', ')}`
    )
    console.log(`stats(): ${JSON.stringify(finalStats)}`)
    const top3 = [...results]
      .sort((a, b) => b.parityPct - a.parityPct)
      .slice(0, 3)
    console.log(
      `top mismatch offsets: ${top3
        .map((r) => `${r.y}px (${r.parityPct.toFixed(2)}%)`)
        .join(', ')}`
    )

    if (
      args.parityMax !== null &&
      results.some((r) => r.parityPct > (args.parityMax as number))
    ) {
      console.error('\n[site] FAILED — parity exceeded --parity-max')
      process.exitCode = 1
    } else {
      console.log('\n[site] OK')
    }
  } finally {
    await browser?.close()
    await devServer?.close()
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
