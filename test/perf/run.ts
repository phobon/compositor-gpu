// Perf harness: boots playground/perf.html (an N-card grid) in headless
// Chromium and measures the compositor's read/upload/encode timings via
// window.__perf. Prints a compact table and writes test/perf/out/last.json.
//
// Usage:
//   npm run test:perf                 # n=400
//   npm run test:perf -- --n 1000
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import { launchWithFallback } from '../lib/browser'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const outDir = resolve(here, 'out')
mkdirSync(outDir, { recursive: true })

function parseN(argv: string[]): number {
  const idx = argv.indexOf('--n')
  if (idx === -1) {
    return 400
  }
  const v = Number(argv[idx + 1])
  return Number.isFinite(v) && v > 0 ? v : 400
}

interface Stats {
  active: boolean
  boxes: number
  images: number
  glyphs: number
  fallback: number
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

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const v = s.length % 2 ? s[mid] : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
  return v ?? 0
}

function p90(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)
  return s[idx] ?? 0
}

/** Run `kind` `count` times, waiting two rAFs after each, and return the
 * readMs stat sampled after each one. Runs inside the page so the loop
 * isn't paced by Playwright round-trips. */
async function sampleReadMs(
  page: Page,
  kind: 'full' | 'text' | 'class',
  count: number
): Promise<number[]> {
  return page.evaluate(
    async ({ kind, count }) => {
      const perf = window.__perf
      if (!perf) {
        return []
      }
      const samples: number[] = []
      for (let i = 0; i < count; i++) {
        if (kind === 'full') {
          perf.invalidate()
        } else {
          perf.mutate(kind)
        }
        await new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r()))
        )
        samples.push(perf.stats().readMs)
      }
      return samples
    },
    { kind, count }
  )
}

interface FrameSample {
  encodeMs: number
  uploadMs: number
  fps: number
}

/** Force `count` frames with nothing dirty (alternating 1px scrolls) and
 * sample encode/upload timing + fps after each. */
async function sampleSteadyFrames(
  page: Page,
  count: number
): Promise<FrameSample[]> {
  return page.evaluate(async (count) => {
    const perf = window.__perf
    if (!perf) {
      return []
    }
    const samples: FrameSample[] = []
    let dir = 1
    for (let i = 0; i < count; i++) {
      window.scrollBy(0, dir)
      dir = -dir
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r()))
      )
      const s = perf.stats()
      samples.push({ encodeMs: s.encodeMs, uploadMs: s.uploadMs, fps: s.fps })
    }
    return samples
  }, count)
}

async function main(): Promise<void> {
  const n = parseN(process.argv.slice(2))

  let server: ViteDevServer | null = null
  let browser: Browser | null = null

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
    console.log(`[perf] vite dev server at ${url}`)

    const { browser: b, usedSwiftshader } = await launchWithFallback(
      url,
      'perf'
    )
    browser = b
    console.log(
      `[perf] chromium launched (${usedSwiftshader ? 'swiftshader' : 'native'}), n=${n}`
    )

    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce'
    })

    await page.goto(`${url}perf.html?n=${n}`, { waitUntil: 'load' })
    await page.waitForFunction(() => Boolean(window.__perf), null, {
      timeout: 30_000
    })
    try {
      await page.evaluate(
        () =>
          new Promise<void>((resolvePromise, reject) => {
            const timeout = setTimeout(
              () => reject(new Error('window.__perf.ready timed out')),
              30_000
            )
            window.__perf?.ready.then(() => {
              clearTimeout(timeout)
              resolvePromise()
            }, reject)
          })
      )
    } catch (e) {
      throw new Error(
        `[perf] fixture never became ready (window.__perf.ready): ${(e as Error).message}`
      )
    }

    const initialStats = (await page.evaluate(() => window.__perf?.stats())) as
      | Stats
      | undefined
    if (!initialStats?.active) {
      throw new Error(
        '[perf] compositor.stats().active is false — WebGPU did not ' +
          'activate in this browser.'
      )
    }

    // (a) full read.
    const fullReadMs = await sampleReadMs(page, 'full', 10)
    // (b) partial read (text edit).
    const textReadMs = await sampleReadMs(page, 'text', 20)
    // Also: partial read (class toggle).
    const classReadMs = await sampleReadMs(page, 'class', 20)
    // (c) steady frame: nothing dirty, 30 forced frames.
    const steady = await sampleSteadyFrames(page, 30)
    // (d) final counts.
    const finalStats = (await page.evaluate(() =>
      window.__perf?.stats()
    )) as Stats

    const encodeMs = steady.map((s) => s.encodeMs)
    const uploadMs = steady.map((s) => s.uploadMs)
    const fpsSamples = steady.map((s) => s.fps)

    const result = {
      n,
      usedSwiftshader,
      counts: {
        boxes: finalStats.boxes,
        glyphs: finalStats.glyphs,
        images: finalStats.images,
        fallback: finalStats.fallback,
        batches: finalStats.batches,
        draws: finalStats.draws,
        groups: finalStats.groups,
        readElements: finalStats.readElements
      },
      fullRead: { medianMs: median(fullReadMs), p90Ms: p90(fullReadMs) },
      partialReadText: {
        medianMs: median(textReadMs),
        p90Ms: p90(textReadMs)
      },
      partialReadClass: {
        medianMs: median(classReadMs),
        p90Ms: p90(classReadMs)
      },
      steadyFrame: {
        encodeMsMedian: median(encodeMs),
        encodeMsP90: p90(encodeMs),
        uploadMsMedian: median(uploadMs),
        uploadMsP90: p90(uploadMs),
        fpsMedian: median(fpsSamples)
      }
    }

    writeFileSync(resolve(outDir, 'last.json'), JSON.stringify(result, null, 2))
    printTable(result)
  } finally {
    await browser?.close()
    await server?.close()
  }
}

function printTable(r: {
  n: number
  usedSwiftshader: boolean
  counts: {
    boxes: number
    glyphs: number
    images: number
    fallback: number
    batches: number
    draws: number
    groups: number
    readElements: number
  }
  fullRead: { medianMs: number; p90Ms: number }
  partialReadText: { medianMs: number; p90Ms: number }
  partialReadClass: { medianMs: number; p90Ms: number }
  steadyFrame: {
    encodeMsMedian: number
    encodeMsP90: number
    uploadMsMedian: number
    uploadMsP90: number
    fpsMedian: number
  }
}): void {
  const ms = (v: number): string => v.toFixed(3)
  console.log(
    `\n[perf] n=${r.n} (${r.usedSwiftshader ? 'swiftshader' : 'native GPU'})`
  )
  console.log(
    `  scene: boxes=${r.counts.boxes} glyphs=${r.counts.glyphs} ` +
      `images=${r.counts.images} fallback=${r.counts.fallback} ` +
      `batches=${r.counts.batches} draws=${r.counts.draws} ` +
      `groups=${r.counts.groups} readElements=${r.counts.readElements}`
  )
  console.log('\n  metric                median (ms)   p90 (ms)')
  console.log('  --------------------------------------------')
  console.log(
    `  full read              ${ms(r.fullRead.medianMs).padStart(9)}   ${ms(r.fullRead.p90Ms).padStart(8)}`
  )
  console.log(
    `  partial read (text)    ${ms(r.partialReadText.medianMs).padStart(9)}   ${ms(r.partialReadText.p90Ms).padStart(8)}`
  )
  console.log(
    `  partial read (class)   ${ms(r.partialReadClass.medianMs).padStart(9)}   ${ms(r.partialReadClass.p90Ms).padStart(8)}`
  )
  console.log(
    `  steady encode           ${ms(r.steadyFrame.encodeMsMedian).padStart(9)}   ${ms(r.steadyFrame.encodeMsP90).padStart(8)}`
  )
  console.log(
    `  steady upload           ${ms(r.steadyFrame.uploadMsMedian).padStart(9)}   ${ms(r.steadyFrame.uploadMsP90).padStart(8)}`
  )
  console.log(`  steady fps (median)     ${r.steadyFrame.fpsMedian.toFixed(1)}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
