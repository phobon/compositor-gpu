// Edit equivalence check for CompositorOptions.patchEdits: loads perf.html
// (n=400), makes a series of edits (class toggles, same-length word swaps,
// heading text, inline colour, a longer word that changes glyph counts,
// opacity changes on three elements),
// a frame each, then captures the canvas with the page's own paint hidden;
// forces a full read (compositor.invalidate) and captures again. The two
// must match: a patched scene has to draw what a rebuilt one draws. Prints
// how many reads were patched and how many pixels differ; screenshots go
// to test/edit/out/.
//
// Usage: npx tsx test/edit/run.ts [--headed]
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

const headed = process.argv.includes('--headed')

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
  if (!headed) {
    return (await launchWithFallback(url, 'edit')).browser
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
  let failed = false
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 }
    })
    await page.goto(`${base}perf.html?n=400`)
    await page.waitForFunction(() => '__perf' in window, null, {
      timeout: 120_000
    })
    await page.evaluate('window.__perf.ready')
    const counts = await page.evaluate(`(async () => {
      const raf = () => new Promise((r) => requestAnimationFrame(r))
      const raf2 = async () => { await raf(); await raf() }
      const g = window.__gpu
      g.setSourceHidden(true)
      await raf2()
      const before = g.stats()
      const cards = Array.from(document.querySelectorAll('.pcard'))
      for (let f = 0; f < 12; f++) {
        window.__perf.mutate(f % 2 ? 'text' : 'class')
        await raf2()
      }
      // Same-length heading text on three cards (glyphs move).
      for (const i of [1, 2, 4]) {
        const h = cards[i].querySelector('h3')
        h.textContent = h.textContent.replace(/Card (\\d)/, 'Cord $1')
        await raf2()
      }
      // Inline colour on a word (paint only).
      const b = cards[2].querySelector('b')
      if (b) {
        b.style.color = '#ff6a3d'
        await raf2()
      }
      // A longer word: glyph counts change, so the scene is rebuilt.
      const w = cards[5].querySelector('.mword')
      if (w) {
        w.textContent = 'remarkably'
        await raf2()
      }
      // Back to a same-length swap after the rebuild.
      window.__perf.mutate('text')
      await raf2()
      await raf2()
      // Opacity (CompositorOptions.patchOpacity): three elements below 1
      // (new groups: a rebuild), new values (patched: the groups' alpha),
      // then one back to 1 (held as a group: patched too). The third is
      // in a dimmed card (a nested group).
      const ops = [
        cards[1].querySelector('h3'),
        cards[3].querySelector('p'),
        cards[6].querySelector('li')
      ].filter(Boolean)
      ops.forEach((el, i) => { el.style.opacity = String(0.3 + 0.2 * i) })
      await raf2()
      const mid = g.stats()
      ops.forEach((el, i) => { el.style.opacity = String(0.6 + 0.1 * i) })
      await raf2()
      ops[0].style.opacity = '1'
      await raf2()
      const after = g.stats()
      return {
        partial: after.partialReads - before.partialReads,
        patched: after.patchedReads - before.patchedReads,
        opacity: after.patchedReads - mid.patchedReads
      }
    })()`)
    const a = PNG.sync.read(
      await page.screenshot({ path: resolve(outDir, 'patched.png') })
    )
    await page.evaluate(`(async () => {
      const raf = () => new Promise((r) => requestAnimationFrame(r))
      window.__gpu.invalidate()
      for (let i = 0; i < 6; i++) await raf()
    })()`)
    const b = PNG.sync.read(
      await page.screenshot({ path: resolve(outDir, 'rebuilt.png') })
    )
    const diff = differing(a, b)
    console.log(
      `partial reads ${counts.partial}, patched ${counts.patched} (opacity ${counts.opacity} of 2); ${diff} px differ between the patched and rebuilt canvas`
    )
    failed = diff > 0 || counts.patched === 0 || counts.opacity < 2
  } finally {
    await browser.close()
    await server.close()
  }
  if (failed) {
    console.log('[edit] FAILED')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
