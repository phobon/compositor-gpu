// Fill check for CompositorOptions.canvasFill: loads perf.html (n=400)
// with each canvasFill (perf.html's own default is 'full'), scrolls to
// 3000 px in 600 px steps (so the canvas re-anchors and 'band' shifts its
// kept pixels), then 8 frames of 40 px steps, then stops the compositor's
// redraws (requestAnimationFrame disabled, as in a main-thread stall) and
// scrolls 600 px further, with the page's own paint hidden. It prints the
// rows the last frame drew, the instances drawn, how many viewport rows
// are left flat (blank, or empty space between cards), and how many
// pixels differ from 'full''s screenshot; screenshots go to
// test/fill/out/. 'bandcanvas' is 'band' culled to the canvas rather than
// the band (`cullDraws: 'canvas'`); 'bandclear' clears the margins.
//
// Usage: npx tsx test/fill/run.ts [--headed] [--fixed] [--blur] [--up]
//   [--nodim]
//   --headed   installed Chrome, headed (a real GPU; headless Chrome falls
//              back to SwiftShader)
//   --fixed    perf.html?fixed: a fixed header bar (viewport-space records)
//   --blur     the fullscreen blur post pass on (a post chain)
//   --up       the stalled scroll goes up instead of down
//   --nodim    perf.html?nodim: no opacity groups
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium } from 'playwright'
import { PNG } from 'pngjs'
import { createServer } from 'vite'
import { launchWithFallback } from '../lib/browser'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const outDir = resolve(here, 'out')
mkdirSync(outDir, { recursive: true })

const args = process.argv.slice(2)
const flag = (name: string): boolean => args.includes(`--${name}`)

/** Rows whose pixels all match the row's first pixel (within 2). */
function flatRows(png: PNG): number {
  let n = 0
  for (let y = 0; y < png.height; y++) {
    const o = y * png.width * 4
    let flat = true
    for (let x = 1; x < png.width && flat; x++) {
      const p = o + x * 4
      for (let c = 0; c < 3; c++) {
        if (Math.abs((png.data[p + c] ?? 0) - (png.data[o + c] ?? 0)) > 2) {
          flat = false
        }
      }
    }
    if (flat) {
      n++
    }
  }
  return n
}

/** Pixels of `a` and `b` (same size) differing by more than 8 in a
 * channel. */
function differing(a: PNG, b: PNG): number {
  let n = 0
  for (let p = 0; p < a.data.length; p += 4) {
    for (let c = 0; c < 3; c++) {
      if (Math.abs((a.data[p + c] ?? 0) - (b.data[p + c] ?? 0)) > 8) {
        n++
        break
      }
    }
  }
  return n
}

async function launch(url: string): Promise<Browser> {
  if (!flag('headed')) {
    return (await launchWithFallback(url, 'fill')).browser
  }
  return chromium.launch({
    headless: false,
    args: ['--enable-unsafe-webgpu', '--disable-lcd-text'],
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : { channel: 'chrome' })
  })
}

async function main(): Promise<void> {
  const server = await createServer({
    configFile: resolve(root, 'vite.config.ts'),
    server: { port: 0, open: false }
  })
  await server.listen()
  const base = server.resolvedUrls?.local[0]
  if (!base) {
    throw new Error('vite dev server produced no resolved URL')
  }
  const browser = await launch(`${base}perf.html`)
  const variant = (flag('fixed') ? '&fixed' : '') + (flag('nodim') ? '&nodim' : '')
  const suffix =
    (flag('fixed') ? '-fixed' : '') +
    (flag('blur') ? '-blur' : '') +
    (flag('up') ? '-up' : '')
  const stall = flag('up') ? -600 : 600
  try {
    const modes: Record<string, string> = {
      full: '',
      band: '&band',
      bandcanvas: '&band&bandcanvas',
      bandclear: '&bandclear'
    }
    let reference: PNG | null = null
    for (const [mode, query] of Object.entries(modes)) {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 }
      })
      await page.goto(`${base}perf.html?n=400${query}${variant}`)
      await page.waitForFunction(() => '__perf' in window, null, {
        timeout: 120_000
      })
      await page.evaluate('window.__perf.ready')
      const { rows, instances, adapter } = await page.evaluate(`(async () => {
        const raf2 = () => new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)))
        if (${flag('blur')}) {
          window.__perf.setBlur(true)
        }
        for (let y = 600; y <= 3000; y += 600) {
          window.scrollTo(0, y)
          await raf2()
        }
        await raf2()
        // Let the jumps age out of the band's scroll history, then scroll
        // in small steps, as a reader would.
        await new Promise((r) => setTimeout(r, 300))
        for (let i = 0; i < 8; i++) {
          window.scrollBy(0, 40)
          await raf2()
        }
        const g = window.__gpu
        g.setSourceHidden(true)
        for (let i = 0; i < 6; i++) {
          await raf2()
        }
        const { fillRows: rows, instances } = g.stats()
        const a = await navigator.gpu?.requestAdapter()
        const adapter = a?.info?.description || a?.info?.vendor || 'none'
        window.requestAnimationFrame = () => 0
        window.scrollBy(0, ${stall})
        await new Promise((r) => setTimeout(r, 300))
        return { rows, instances, adapter }
      })()`)
      const path = resolve(outDir, `${mode}${suffix}.png`)
      const png = PNG.sync.read(await page.screenshot({ path }))
      reference ??= png
      console.log(
        `${mode.padEnd(10)} rows drawn ${rows}, instances ${instances}, flat viewport rows after a ${stall} px stall ${flatRows(png)} of ${png.height}, ${differing(png, reference)} px differ from full (${adapter})`
      )
      await page.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
