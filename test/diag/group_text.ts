// Diagnostic: does text draw the same on the page and in an isolated group?
// (ROADMAP: "Text in isolated groups draws slightly differently".)
//
// Loads playground/sdf.html?vr&off, moves the heading down by 0..7 px and
// screenshots it drawn on the page, then once inside a group (a layer
// transform at opacity 0.999), and prints, per offset, how many pixels of
// the heading differ from the group's drawing and by how much (levels).
// The group's drawing doesn't change with the offset; the page's should
// match it (at most 1 level) at every offset.
//
//   npx tsx test/diag/group_text.ts               headed, the real GPU
//   npx tsx test/diag/group_text.ts --swiftshader  headless SwiftShader
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { createServer } from 'vite'
import { SWIFTSHADER_ARGS } from '../lib/browser'

const root = resolve(fileURLToPath(import.meta.url), '../../..')
const soft = process.argv.includes('--swiftshader')

const server = await createServer({
  configFile: resolve(root, 'vite.config.ts'),
  server: { port: 0, open: false, strictPort: false }
})
await server.listen()
const url = server.resolvedUrls?.local[0] ?? ''
const executablePath = process.env.CHROMIUM_PATH || undefined
const browser = await chromium.launch(
  soft
    ? { executablePath, args: SWIFTSHADER_ARGS }
    : {
        executablePath,
        headless: false,
        args: ['--enable-unsafe-webgpu', '--disable-lcd-text']
      }
)
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1
  })
  await page.goto(`${url}sdf.html?vr&off`, { waitUntil: 'load' })
  await page.waitForFunction(
    () => Boolean((window as unknown as { __fx?: unknown }).__fx),
    null,
    {
      timeout: 60_000
    }
  )
  const adapter = await page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter()
    const info = (a as { info?: { vendor?: string; architecture?: string } })
      ?.info
    return info ? `${info.vendor ?? '?'} ${info.architecture ?? ''}` : 'none'
  })
  console.log(`[diag] ${soft ? 'swiftshader' : 'headed'}, adapter: ${adapter}`)
  const frames = (n: number): Promise<void> =>
    page.evaluate(async (k) => {
      for (let i = 0; i < k; i++) {
        await new Promise((r) => requestAnimationFrame(r))
      }
    }, n)
  const clip = { x: 0, y: 0, width: 420, height: 300 }
  const grab = async (): Promise<PNG> => {
    await frames(12)
    await page.waitForTimeout(400)
    return PNG.sync.read(await page.screenshot({ clip }))
  }
  await page.evaluate(() => {
    const w = document.getElementById('word') as HTMLElement
    w.style.position = 'relative'
  })
  const offsets = [0, 1, 2, 3, 4, 5, 6, 7]
  const shots: PNG[] = []
  for (const y of offsets) {
    await page.evaluate((v) => {
      ;(document.getElementById('word') as HTMLElement).style.top = `${v}px`
    }, y)
    shots.push(await grab())
  }
  await page.evaluate(() => {
    ;(document.getElementById('word') as HTMLElement).style.top = '0px'
    const fx = (window as unknown as { __fx: unknown }).__fx as {
      transform(el: Element, o: { opacity: number }): unknown
    }
    fx.transform(document.getElementById('word') as Element, {
      opacity: 0.999
    })
  })
  const group = await grab()
  // The heading's rows (60..215) at each offset against the group's.
  const lum = (p: PNG, x: number, y: number): number => {
    const i = (y * p.width + x) * 4
    return Math.max(p.data[i] ?? 0, p.data[i + 1] ?? 0, p.data[i + 2] ?? 0)
  }
  offsets.forEach((y, k) => {
    const s = shots[k] as PNG
    let n = 0
    let max = 0
    for (let r = 60; r < 215; r++) {
      for (let x = 0; x < 400; x++) {
        const d = Math.abs(lum(s, x, r + y) - lum(group, x, r))
        if (d > 0) {
          n++
        }
        max = Math.max(max, d)
      }
    }
    console.log(
      `offset ${y}: ${n} px differ, max ${max}${max > 1 ? '  <- differs' : ''}`
    )
  })
} finally {
  await browser.close()
  await server.close()
}
