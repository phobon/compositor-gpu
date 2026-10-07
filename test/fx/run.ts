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
//   fx-displace-push  displace with the pointer warp in push mode
//   fx-geometry       the geometry section, nothing enabled
//   fx-glow           cursorGlow placed 'below' (over the page background,
//                     under the section's content)
//   fx-ripple         clickRipple with two pinned clicks
//   fx-after          a Layer placed after the blue box: over it, under the
//                     boxes that follow
//   fx-region         blur as a region pass on the card only
//   fx-region-then-off  region on, then off: equal to fx-geometry exactly
//                     (isolation torn down)
//   fx-progressive    progressiveBlur (bottom corners) as a region pass on
//                     an arc of images
//   fx-materials      the materials section, nothing enabled
//   fx-mat-ripple     ripple (image material) with two pinned clicks
//   fx-mat-wave       glyph vertex + fragment hooks on the heading
//   fx-mat-bend       image vertex hook on a 16×16 grid; the <img>'s DOM
//                     paint must be hidden while on and restored after
//   fx-mat-stripes    box fragment hook
//   fx-mat-then-off   all four on, then off: equal to fx-materials exactly
//   fx-m3b            the M3b section, nothing enabled
//   fx-layer-glyphs   a Layer drawing the heading's glyphs through Slug
//   fx-layer-image    a Layer sampling the <img> Target as four tiles
//   fx-sim            a Layer with a 'use gpu' simulate hook (fixed dt,
//                     run until converged)
//   fx-mat-raw        a raw box program (default_vs/default_fs wrapped)
//   fx-mat-tgpu       a 'use gpu' material fragment
//   fx-tgpu-js        the fx-off section through a 'use gpu' pass
//   fx-m3b-then-off   the M3b effects on, then off: equal to fx-m3b exactly
//   fx-follow         the stagger section, nothing enabled
//   fx-mat-stagger    a glyph material staggered by mat_index
//   fx-follow-then-off  stagger on, then off: equal to fx-follow exactly
//   fx-pass-image     the fx-off section through a pass sampling #mat-img
//   fx-transform-off  the transform section, nothing enabled
//   fx-transform      three cards with pinned layer transforms (one moved
//                     past the row's overflow clip)
//   fx-transform-identity  identity transforms: equal to fx-transform-off
//                     exactly (an isolated group composites in place)
//   fx-transform-then-off  pinned, then off: equal to fx-transform-off
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

type Effect =
  | 'none'
  | 'blur'
  | 'displace'
  | 'displace-push'
  | 'tgpu'
  | 'glow'
  | 'ripple'
  | 'after'
  | 'region'
  | 'progressive'
  | 'transform'
  | 'transform-id'
  | 'mripple'
  | 'wave'
  | 'bend'
  | 'tint'
  | 'materials'
  | 'lglyphs'
  | 'limage'
  | 'sim'
  | 'raw'
  | 'tgbox'
  | 'tgjs'
  | 'm3b'
  | 'stagger'
  | 'pimage'

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
    h.displace.enabled = e === 'displace' || e === 'displace-push'
    ;(h.displace.params as Record<string, number>).mode =
      e === 'displace-push' ? 1 : 0
    h.tgpu.enabled = e === 'tgpu'
    h.glow.enabled = e === 'glow'
    h.ripple.enabled = e === 'ripple'
    h.after.enabled = e === 'after'
    h.region.enabled = e === 'region'
    h.progressive.enabled = e === 'progressive'
    h.tfSet(
      e === 'transform' ? 'pinned' : e === 'transform-id' ? 'identity' : 'off'
    )
    h.mripple.enabled = e === 'mripple' || e === 'materials'
    h.wave.enabled = e === 'wave' || e === 'materials'
    h.bend.enabled = e === 'bend' || e === 'materials'
    h.tint.enabled = e === 'tint' || e === 'materials'
    h.lglyphs.enabled = e === 'lglyphs' || e === 'm3b'
    h.limage.enabled = e === 'limage' || e === 'm3b'
    h.raw.enabled = e === 'raw' || e === 'm3b'
    h.tgbox.enabled = e === 'tgbox' || e === 'm3b'
    h.tgjs.enabled = e === 'tgjs'
    h.stagger.enabled = e === 'stagger'
    h.pimage.enabled = e === 'pimage'
    const sim = e === 'sim' || e === 'm3b'
    if (sim) {
      // A fixed step, so the eased dots converge the same way every run.
      h.fx.__override({
        time: 1.25,
        elapsed: 1.25,
        dt: 1 / 60,
        pointer: { x: 640, y: 450, follow: { x: 640, y: 450 } }
      })
    }
    h.sim.enabled = sim
    for (let i = 0; sim && i < 2000 && h.sim.steps < 90; i++) {
      await h.raf2()
    }
    if (e === 'ripple') {
      h.pinClicks()
    }
    if (e === 'mripple' || e === 'materials') {
      h.pinClicksOn('mat-img')
    }
    await h.raf2()
    // Material pipelines compile asynchronously (the default pipeline
    // draws until they're ready).
    for (let i = 0; i < 600 && h.fx.__pending() > 0; i++) {
      await h.raf2()
    }
    await h.raf2()
    // A region toggle schedules a full read; let it land.
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
    if (want('fx-displace-push')) {
      await capture('fx-displace', 'fx-displace-push', 'displace-push')
    }
    const geo = 'fx-geometry'
    let geoPre: PNG | null = null
    if (want(geo) || want('fx-region-then-off')) {
      geoPre = await capture(geo, geo, 'none')
    }
    if (want('fx-glow')) {
      await capture(geo, 'fx-glow', 'glow')
    }
    if (want('fx-ripple')) {
      await capture(geo, 'fx-ripple', 'ripple')
      // Back to the plain pinned pointer (fx.html's vr override).
      await page.evaluate(() =>
        window.__fx?.fx.__override({
          time: 1.25,
          elapsed: 1.25,
          pointer: { x: 640, y: 450, follow: { x: 640, y: 450 } }
        })
      )
    }
    if (want('fx-after')) {
      await capture(geo, 'fx-after', 'after')
    }
    if (want('fx-region') || want('fx-region-then-off')) {
      await capture(geo, 'fx-region', 'region')
    }
    if (want('fx-region-then-off')) {
      const post = await capture(geo, 'fx-region-then-off', 'none')
      if (geoPre && post) {
        const n = exactDiff(geoPre, post)
        const pct = diffPng(
          geoPre,
          post,
          resolve(outDir, 'fx-region-then-off-invariant.png')
        )
        results.push({
          name: 'fx-region-then-off (= geo)',
          regressionPct: pct,
          status: n === 0 ? 'ok' : 'fail',
          note: `${n} px differ`
        })
      }
    }
    if (want('fx-progressive')) {
      await capture('fx-progressive', 'fx-progressive', 'progressive')
    }
    const pinPlain = (): Promise<void> =>
      page.evaluate(() =>
        window.__fx?.fx.__override({
          time: 1.25,
          elapsed: 1.25,
          pointer: { x: 640, y: 450, follow: { x: 640, y: 450 } }
        })
      )
    const mats = 'fx-materials'
    let matPre: PNG | null = null
    if (want(mats) || want('fx-mat-then-off')) {
      matPre = await capture(mats, mats, 'none')
    }
    if (want('fx-mat-ripple')) {
      await capture(mats, 'fx-mat-ripple', 'mripple')
      await pinPlain()
    }
    if (want('fx-mat-wave')) {
      await capture(mats, 'fx-mat-wave', 'wave')
    }
    if (want('fx-mat-bend')) {
      await capture(mats, 'fx-mat-bend', 'bend')
      // hideSource: the <img> paints nothing in the DOM while bent...
      await setEffect(page, 'bend')
      const on = await page.evaluate(
        () => document.getElementById('mat-img')?.style.opacity
      )
      await setEffect(page, 'none')
      const off = await page.evaluate(
        () => document.getElementById('mat-img')?.style.opacity
      )
      const ok = on === '0' && off === ''
      results.push({
        name: 'fx-mat-bend hides DOM',
        regressionPct: null,
        status: ok ? 'ok' : 'fail',
        note: `opacity on=${JSON.stringify(on)} off=${JSON.stringify(off)}`
      })
    }
    if (want('fx-mat-stripes')) {
      await capture(mats, 'fx-mat-stripes', 'tint')
    }
    if (want('fx-mat-then-off')) {
      await capture(mats, 'fx-mat-all', 'materials')
      await pinPlain()
      const post = await capture(mats, 'fx-mat-then-off', 'none')
      if (matPre && post) {
        const n = exactDiff(matPre, post)
        const pct = diffPng(
          matPre,
          post,
          resolve(outDir, 'fx-mat-then-off-invariant.png')
        )
        results.push({
          name: 'fx-mat-then-off (= mats)',
          regressionPct: pct,
          status: n === 0 ? 'ok' : 'fail',
          note: `${n} px differ`
        })
      }
    }
    const m3b = 'fx-m3b'
    let m3bPre: PNG | null = null
    if (want(m3b) || want('fx-m3b-then-off')) {
      m3bPre = await capture(m3b, m3b, 'none')
    }
    if (want('fx-layer-glyphs')) {
      await capture(m3b, 'fx-layer-glyphs', 'lglyphs')
    }
    if (want('fx-layer-image')) {
      await capture(m3b, 'fx-layer-image', 'limage')
    }
    if (want('fx-sim')) {
      await capture(m3b, 'fx-sim', 'sim')
    }
    if (want('fx-mat-raw')) {
      await capture(m3b, 'fx-mat-raw', 'raw')
    }
    if (want('fx-mat-tgpu')) {
      await capture(m3b, 'fx-mat-tgpu', 'tgbox')
    }
    if (want('fx-tgpu-js')) {
      await capture('fx-off', 'fx-tgpu-js', 'tgjs')
    }
    if (want('fx-m3b-then-off')) {
      await capture(m3b, 'fx-m3b-all', 'm3b')
      const post = await capture(m3b, 'fx-m3b-then-off', 'none')
      if (m3bPre && post) {
        const n = exactDiff(m3bPre, post)
        const pct = diffPng(
          m3bPre,
          post,
          resolve(outDir, 'fx-m3b-then-off-invariant.png')
        )
        results.push({
          name: 'fx-m3b-then-off (= m3b)',
          regressionPct: pct,
          status: n === 0 ? 'ok' : 'fail',
          note: `${n} px differ`
        })
      }
    }
    const fol = 'fx-follow'
    let folPre: PNG | null = null
    if (want(fol) || want('fx-follow-then-off')) {
      folPre = await capture(fol, fol, 'none')
    }
    if (want('fx-mat-stagger') || want('fx-follow-then-off')) {
      await capture(fol, 'fx-mat-stagger', 'stagger')
    }
    if (want('fx-follow-then-off')) {
      const post = await capture(fol, 'fx-follow-then-off', 'none')
      if (folPre && post) {
        const n = exactDiff(folPre, post)
        const pct = diffPng(
          folPre,
          post,
          resolve(outDir, 'fx-follow-then-off-invariant.png')
        )
        results.push({
          name: 'fx-follow-then-off (= fol)',
          regressionPct: pct,
          status: n === 0 ? 'ok' : 'fail',
          note: `${n} px differ`
        })
      }
    }
    if (want('fx-pass-image')) {
      await capture('fx-off', 'fx-pass-image', 'pimage')
    }
    const tfs = 'fx-transform'
    const tfInv = ['fx-transform-identity', 'fx-transform-then-off']
    let tfPre: PNG | null = null
    if (want('fx-transform-off') || tfInv.some(want)) {
      tfPre = await capture(tfs, 'fx-transform-off', 'none')
    }
    const same = (name: string, post: PNG | null): void => {
      if (tfPre && post) {
        const n = exactDiff(tfPre, post)
        const pct = diffPng(
          tfPre,
          post,
          resolve(outDir, `${name}-invariant.png`)
        )
        results.push({
          name: `${name} (= off)`,
          regressionPct: pct,
          status: n === 0 ? 'ok' : 'fail',
          note: `${n} px differ`
        })
      }
    }
    if (want('fx-transform-identity')) {
      same(
        'fx-transform-identity',
        await capture(tfs, 'fx-transform-identity', 'transform-id')
      )
    }
    if (want(tfs) || want('fx-transform-then-off')) {
      await capture(tfs, tfs, 'transform')
    }
    if (want('fx-transform-then-off')) {
      same(
        'fx-transform-then-off',
        await capture(tfs, 'fx-transform-then-off', 'none')
      )
    }
    await pinPlain()
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
