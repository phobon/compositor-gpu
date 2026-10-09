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
//   npm run test:visual -- --with-fx      # load `?vr&fx`: compositor-gpu/fx
//                                         # installed, no pass enabled
//
// Per-section attributes:
//   data-vr-body-class="c"  add class c to <body> for the capture (and force
//                           a full re-read: <body> is outside the root)
//   data-vr-scroll="N"      after scrolling the section into view, scroll a
//                           further N px before capturing
//   data-vr-scroll2="M"     also capture after M more px, as `<name>-sM`
//   data-vr-capture="viewport"  capture the whole viewport, not the section
//   data-vr-focus="#id"     also capture with that element focused (as by
//                           keyboard: focus-visible), as `<name>-focus`
//   data-vr-select="#id"    also capture with that element's text selected,
//                           as `<name>-select`
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pixelmatch from 'pixelmatch'
import type { Browser, ElementHandle, Page } from 'playwright'
import { PNG } from 'pngjs'
import { createServer, type ViteDevServer } from 'vite'
import { launchWithFallback } from '../lib/browser'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const outDir = resolve(here, 'out')
const goldenDir = resolve(here, 'golden')
mkdirSync(outDir, { recursive: true })
mkdirSync(goldenDir, { recursive: true })

const SECTIONS = [
  'text',
  'decorations',
  'textshadow',
  'ligatures',
  'texttransform',
  'emoji',
  'boxes',
  'outline',
  'borderfill',
  'shadows',
  'images',
  'gradients',
  'bglayers',
  'selcolor',
  'png16',
  'shapes',
  'overflow',
  'stacking',
  'fixed',
  'sticky',
  'opacity',
  'transforms',
  'mutations',
  'pseudo',
  'canvas',
  'duo'
] as const

interface Args {
  update: boolean
  only: string | null
  parityMax: number | null
  withFx: boolean
}

function parseArgs(argv: string[]): Args {
  let only: string | null = null
  let parityMax: number | null = null
  const update = argv.includes('--update')
  const onlyIdx = argv.indexOf('--only')
  if (onlyIdx !== -1) {
    only = argv[onlyIdx + 1] ?? null
  }
  const pmIdx = argv.indexOf('--parity-max')
  if (pmIdx !== -1) {
    const v = argv[pmIdx + 1]
    if (v) {
      parityMax = Number(v)
    }
  }
  return { update, only, parityMax, withFx: argv.includes('--with-fx') }
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

function raf2(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r()))
      )
  )
}

function setMode(page: Page, mode: 'dom' | 'gpu' | 'both'): Promise<void> {
  return page.evaluate<void, 'dom' | 'gpu' | 'both'>(async (m) => {
    await window.__vr?.setMode(m)
  }, mode)
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
    if (!url) {
      throw new Error('vite dev server produced no resolved URL')
    }
    console.log(`[visual] vite dev server at ${url}`)

    const { browser: b, usedSwiftshader } = await launchWithFallback(
      url,
      'visual'
    )
    browser = b
    console.log(
      `[visual] chromium launched (${usedSwiftshader ? 'swiftshader' : 'native'})`
    )

    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce'
    })

    await page.goto(`${url}?vr${args.withFx ? '&fx' : ''}`, {
      waitUntil: 'load'
    })
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
      `[visual] compositor active — boxes=${stats.boxes} glyphs=${stats.glyphs} images=${stats.images} ligatures=${stats.ligatures}`
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

      const opts = await handle.evaluate((el) => ({
        bodyClass: el.getAttribute('data-vr-body-class'),
        scroll: Number(el.getAttribute('data-vr-scroll') ?? 0),
        scroll2: Number(el.getAttribute('data-vr-scroll2') ?? 0),
        viewport: el.getAttribute('data-vr-capture') === 'viewport',
        focus: el.getAttribute('data-vr-focus'),
        select: el.getAttribute('data-vr-select')
      }))
      if (opts.bodyClass) {
        await page.evaluate((c) => {
          document.body.classList.add(c)
          window.__vr?.invalidate()
        }, opts.bodyClass)
      }
      try {
        await handle.evaluate((el) =>
          el.scrollIntoView({ behavior: 'instant', block: 'center' })
        )
        await raf2(page)
        const shots: [string, number][] = [[name, opts.scroll]]
        if (opts.scroll2) {
          shots.push([`${name}-s${opts.scroll2}`, opts.scroll2])
        }
        for (const [shot, by] of shots) {
          if (by) {
            await page.evaluate((y) => window.scrollBy(0, y), by)
            await raf2(page)
          }
          const r = await captureSection(page, handle, shot, opts.viewport)
          if (!r) {
            console.error(
              `[visual] MISSING/empty section ${selector} (offscreen)`
            )
            results.push({
              name: shot,
              parityPct: null,
              regressionPct: null,
              status: 'missing'
            })
            hadFailure = true
            continue
          }
          const res = judge(shot, r.domPath, r.gpuPath, args)
          if (res.status === 'fail') {
            hadFailure = true
          }
          results.push(res)
        }
        if (opts.focus) {
          // Focus changes no attribute: the compositor re-reads on focusin.
          await page.evaluate((sel) => {
            const el = document.querySelector(sel)
            if (el instanceof HTMLElement) {
              el.focus({ focusVisible: true } as FocusOptions)
            }
          }, opts.focus)
          await raf2(page)
          await raf2(page)
          const shot = `${name}-focus`
          const r = await captureSection(page, handle, shot, opts.viewport)
          await page.evaluate(() => {
            const a = document.activeElement
            if (a instanceof HTMLElement) {
              a.blur()
            }
          })
          await raf2(page)
          if (r) {
            const res = judge(shot, r.domPath, r.gpuPath, args)
            if (res.status === 'fail') {
              hadFailure = true
            }
            results.push(res)
          }
        }
        if (opts.select) {
          // The compositor re-reads the selected text on selectionchange.
          await page.evaluate((sel) => {
            const el = document.querySelector(sel)
            const s = document.getSelection()
            if (el && s) {
              const r = document.createRange()
              r.selectNodeContents(el)
              s.removeAllRanges()
              s.addRange(r)
            }
          }, opts.select)
          await raf2(page)
          await raf2(page)
          const shot = `${name}-select`
          const r = await captureSection(page, handle, shot, opts.viewport)
          await page.evaluate(() => document.getSelection()?.removeAllRanges())
          await raf2(page)
          await raf2(page)
          if (r) {
            const res = judge(shot, r.domPath, r.gpuPath, args)
            if (res.status === 'fail') {
              hadFailure = true
            }
            results.push(res)
          }
        }
      } finally {
        if (opts.bodyClass) {
          await page.evaluate((c) => {
            document.body.classList.remove(c)
            window.__vr?.invalidate()
          }, opts.bodyClass)
          await raf2(page)
        }
      }
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

/** DOM and GPU captures of `handle`'s section (or the whole viewport),
 * as `<shot>-dom.png` / `<shot>-gpu.png`; null when it is offscreen. */
async function captureSection(
  page: Page,
  handle: ElementHandle<Element>,
  shot: string,
  viewport: boolean
): Promise<{ domPath: string; gpuPath: string } | null> {
  const vw = 1280
  const vh = 900
  const rect = viewport
    ? { left: 0, top: 0, right: vw, bottom: vh }
    : await handle.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      })
  const left = Math.max(0, Math.floor(rect.left))
  const top = Math.max(0, Math.floor(rect.top))
  const right = Math.min(vw, Math.ceil(rect.right))
  const bottom = Math.min(vh, Math.ceil(rect.bottom))
  const width = right - left
  const height = bottom - top
  if (width <= 0 || height <= 0) {
    return null
  }
  const clipBox = { x: left, y: top, width, height }

  await setMode(page, 'dom')
  const domPath = resolve(outDir, `${shot}-dom.png`)
  await page.screenshot({ path: domPath, clip: clipBox })

  await setMode(page, 'gpu')
  const gpuPath = resolve(outDir, `${shot}-gpu.png`)
  await page.screenshot({ path: gpuPath, clip: clipBox })

  // Restore overlay mode between sections for a consistent starting state.
  await setMode(page, 'both')
  return { domPath, gpuPath }
}

/** Parity (DOM vs GPU) and regression (GPU vs golden) for one capture. */
function judge(
  shot: string,
  domPath: string,
  gpuPath: string,
  args: Args
): SectionResult {
  const parityDiffPath = resolve(outDir, `${shot}-parity-diff.png`)
  const parityPct = diff(domPath, gpuPath, parityDiffPath)

  const goldenPath = resolve(goldenDir, `${shot}.png`)
  let regressionPct: number | null = null
  let status: SectionResult['status'] = 'ok'

  if (args.update) {
    writeFileSync(goldenPath, readFileSync(gpuPath))
  } else if (existsSync(goldenPath)) {
    const goldenDiffPath = resolve(outDir, `${shot}-golden-diff.png`)
    regressionPct = diff(goldenPath, gpuPath, goldenDiffPath)
    if (regressionPct > 0.5) {
      status = 'fail'
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
  }
  return { name: shot, parityPct, regressionPct, status }
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
