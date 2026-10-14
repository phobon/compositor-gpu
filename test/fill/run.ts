// Fill check for CompositorOptions.canvasFill: loads perf.html (n=400)
// with each canvasFill, scrolls to 3000 px in 600 px steps (so the canvas
// re-anchors and 'band' shifts its kept pixels), then stops the
// compositor's redraws (requestAnimationFrame disabled, as in a main-thread
// stall) and scrolls 600 px further, with the page's own paint hidden. It
// prints the rows the last frame drew and how many viewport rows are left
// flat (blank, or empty space between cards), and saves the screenshots to
// test/fill/out/. Also prints the instances drawn, and runs 'band' a second
// time culled to the canvas rather than the band (`cullDraws: 'canvas'`),
// and 'band-clear' (margins cleared rather than kept).
//
// Usage: npx tsx test/fill/run.ts
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { createServer } from 'vite'
import { launchWithFallback } from '../lib/browser'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const outDir = resolve(here, 'out')
mkdirSync(outDir, { recursive: true })

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
  const { browser } = await launchWithFallback(`${base}perf.html`, 'fill')
  try {
    const modes: Record<string, string> = {
      full: '',
      band: '&band',
      bandcanvas: '&band&bandcanvas',
      bandclear: '&bandclear'
    }
    for (const [mode, query] of Object.entries(modes)) {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 }
      })
      await page.goto(`${base}perf.html?n=400${query}`)
      await page.waitForFunction(() => '__perf' in window, null, {
        timeout: 120_000
      })
      await page.evaluate('window.__perf.ready')
      const { rows, instances } = await page.evaluate(`(async () => {
        const raf2 = () => new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)))
        for (let y = 600; y <= 3000; y += 600) {
          window.scrollTo(0, y)
          await raf2()
        }
        await raf2()
        // Let the jump age out of the band's scroll history, then scroll
        // a pixel so the next frame sizes the band from small steps.
        await new Promise((r) => setTimeout(r, 300))
        window.scrollBy(0, 1)
        await raf2()
        const g = window.__gpu
        g.setSourceHidden(true)
        for (let i = 0; i < 6; i++) {
          await raf2()
        }
        const { fillRows: rows, instances } = g.stats()
        window.requestAnimationFrame = () => 0
        window.scrollBy(0, 600)
        await new Promise((r) => setTimeout(r, 300))
        return { rows, instances }
      })()`)
      const path = resolve(outDir, `${mode}.png`)
      const png = PNG.sync.read(await page.screenshot({ path }))
      console.log(
        `${mode.padEnd(10)} rows drawn ${rows}, instances ${instances}, flat viewport rows after a 600 px stall ${flatRows(png)} of ${png.height}`
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
