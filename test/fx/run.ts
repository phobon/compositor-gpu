/// <reference path="../../playground/fx.d.ts" />
/// <reference path="../../playground/perf.d.ts" />
/// <reference path="../../playground/trail.d.ts" />
/// <reference path="../../playground/transition.d.ts" />
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
//   fx-waapi      a geometry-section box faded by element.animate() (fill: forwards):
//                 equal exactly to the same opacity set as a style
//                 (fx-waapi-style)
//   fx-mat-shared  two materials with the same hooks, warmed while
//                 disabled: one pipeline compile, none more when enabled
//   fx-svg-transition  an inline svg icon inside a badge whose scale
//                 transition runs: its image record must be in the scene
//                 on every frame (the local size recovered under the
//                 transform drifts; it must not re-rasterise per frame)
//   fx-reduced    displace drifting on the real clock under reduced motion:
//                 two captures 400 ms apart must be equal exactly, and
//                 motion.play() must land at once
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
//   fx-rgbsplit       the displace section through rgbSplit (radial)
//   fx-rgbsplit-pointer  rgbSplit on the pinned follower, within a radius
//   fx-glitch         glitchSlices with the pattern held
//   fx-vignette       vignette with a white flash
//   fx-lens           lens on the pinned follower
//   fx-reveal         reveal on the section's h2 and develop on its img,
//                     both at progress 0.4
//   fx-reveal-0       both at progress 0 (heading and image hidden)
//   fx-reveal-then-off  on, then off: equal to the section exactly
//   fx-p1-then-off    all five on, then off: equal to the section with
//                     nothing enabled exactly
//   fx-transform-off  the transform section, nothing enabled
//   fx-transform      three cards with pinned layer transforms (one moved
//                     past the row's overflow clip)
//   fx-transform-identity  identity transforms: equal to fx-transform-off
//                     exactly (an isolated group composites in place)
//   fx-transform-then-off  pinned, then off: equal to fx-transform-off
//   fx-dissolve       the transform row half dissolved (noise + sweep, rim)
//   fx-dissolve-full  progress 1: equal to fx-transform-off exactly
//   fx-motion     motions on the cards (half way; composed with a transform;
//                 at rest); must equal fx-motion-ref, the same states as
//                 single transforms, exactly
//   fx-motion-then-off  motions off: equal to fx-transform-off exactly
//   fx-trail-off  playground/trail.html, no stroke (replace mode)
//   fx-trail      a scripted stroke, held: displace pass, light layer and
//                 image material
//   fx-trail-pixel  the same stroke through the pixellate pass
//   fx-trail-clear  stroke, then trail.clear(): equal to fx-trail-off
//   fx-transition-a, -b  playground/transition.html, each state alone
//   fx-transition-0  captured state a, swapped to b, settled, progress 0:
//                    equal to fx-transition-a exactly
//   fx-transition-half  the reveal at progress 0.5
//   fx-transition-1  progress 1: equal to fx-transition-b exactly
//                 exactly
//   fx-trail-reuse  the stroke through the page pass alone: the scene is
//                 still, so frames reuse it (stats().sceneReused); equal
//                 exactly to fx-trail-reuse-off (sceneReuse: false)
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
  | 'motion'
  | 'motion-ref'
  | 'dissolve'
  | 'dissolve-full'
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
  | 'rgb'
  | 'rgb-pointer'
  | 'glitch'
  | 'vignette'
  | 'lens'
  | 'reveal'
  | 'reveal-0'
  | 'p1'

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
    h.dissolve.enabled = e === 'dissolve' || e === 'dissolve-full'
    ;(h.dissolve.params as Record<string, number>).progress =
      e === 'dissolve-full' ? 1 : 0.5
    h.tfSet(
      e === 'transform' ? 'pinned' : e === 'transform-id' ? 'identity' : 'off'
    )
    h.moSet(e === 'motion' ? 'motion' : e === 'motion-ref' ? 'ref' : 'off')
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
    h.rgb.enabled = e === 'rgb' || e === 'p1'
    h.rgbp.enabled = e === 'rgb-pointer' || e === 'p1'
    h.glitch.enabled = e === 'glitch' || e === 'p1'
    h.vig.enabled = e === 'vignette' || e === 'p1'
    h.lens.enabled = e === 'lens' || e === 'p1'
    h.reveal.enabled = e === 'reveal' || e === 'reveal-0'
    h.develop.enabled = e === 'reveal' || e === 'reveal-0'
    for (const m of [h.reveal, h.develop]) {
      ;(m.params as Record<string, number>).progress =
        e === 'reveal-0' ? 0 : 0.4
    }
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
    if (want('fx-waapi')) {
      // The same end state through a style write (a mutation) and through
      // element.animate() with fill: forwards (no mutation, no CSS event):
      // the mirror must show both identically. GPU-only for the whole run:
      // toggling the page's paint is itself a mutation and would re-read.
      const sel = '[data-vr="fx-geometry"] .overlap .b2'
      const clip = await sectionClip(page, 'fx-geometry')
      await setEffect(page, 'none')
      await setMode(page, 'gpu')
      const settle = (): Promise<void> =>
        page.evaluate(async () => {
          for (let i = 0; i < 4; i++) {
            await window.__fx?.raf2()
          }
        })
      await page.evaluate((q) => {
        const el = document.querySelector<HTMLElement>(q)
        if (el) {
          el.style.opacity = '0.4'
        }
      }, sel)
      await settle()
      const viaStyle = clip ? await shoot(page, 'fx-waapi-style', clip) : null
      await page.evaluate((q) => {
        const el = document.querySelector<HTMLElement>(q)
        if (el) {
          el.style.opacity = ''
        }
      }, sel)
      await settle()
      await page.evaluate(async (q) => {
        const el = document.querySelector<HTMLElement>(q)
        const a = el?.animate([{ opacity: 1 }, { opacity: 0.4 }], {
          duration: 200,
          fill: 'forwards'
        })
        await a?.finished
      }, sel)
      await settle()
      const viaAnimate = clip ? await shoot(page, 'fx-waapi', clip) : null
      await page.evaluate((q) => {
        for (const a of document.querySelector(q)?.getAnimations() ?? []) {
          a.cancel()
        }
      }, sel)
      await settle()
      await setMode(page, 'both')
      if (viaStyle && viaAnimate) {
        results.push(judge('fx-waapi', viaAnimate))
        const n = exactDiff(viaStyle, viaAnimate)
        results.push({
          name: 'fx-waapi (= style)',
          regressionPct: diffPng(
            viaStyle,
            viaAnimate,
            resolve(outDir, 'fx-waapi-invariant.png')
          ),
          status: n === 0 ? 'ok' : 'fail',
          note: `${n} px differ`
        })
      }
    }
    if (want('fx-svg-transition')) {
      await setEffect(page, 'none')
      const r = await page.evaluate(async () => {
        const host = document.querySelector('[data-vr="fx-geometry"]')
        const badge = document.createElement('span')
        badge.id = 'svg-badge'
        Object.assign(badge.style, {
          position: 'absolute',
          left: '24px',
          top: '24px',
          display: 'flex',
          width: '32px',
          height: '32px',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '50%',
          background: '#fff',
          transform: 'scale(0.92)',
          transition: 'transform 3s linear'
        })
        badge.innerHTML =
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2.25"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'
        host?.appendChild(badge)
        const fx = window.__fx
        // At rest first: the icon rasterised and in the scene.
        for (let i = 0; i < 40 && (fx?.svgRecords() ?? 0) < 1; i++) {
          await fx?.raf2()
        }
        const before = fx?.svgRecords() ?? 0
        badge.style.transform = 'scale(1)'
        const during: number[] = []
        for (let i = 0; i < 20; i++) {
          await fx?.raf2()
          during.push(fx?.svgRecords() ?? 0)
        }
        badge.remove()
        await fx?.raf2()
        return { before, during }
      })
      const ok = r.before === 1 && r.during.every((n) => n === 1)
      results.push({
        name: 'fx-svg-transition',
        regressionPct: null,
        status: ok ? 'ok' : 'fail',
        note: `svg records at rest ${r.before}, during ${r.during.join('')}`
      })
    }
    if (want('fx-reduced')) {
      // The real clock (pointer still pinned), reduced motion on: the
      // clock holds, so displace's drift stops.
      const clip = await sectionClip(page, 'fx-displace')
      await page.evaluate(() => {
        const fx = window.__fx?.fx
        fx?.__override({
          pointer: { x: 640, y: 450, follow: { x: 640, y: 450 } }
        })
        fx?.setReducedMotion(true)
      })
      await setEffect(page, 'displace')
      const settle = (): Promise<void> =>
        page.evaluate(async () => {
          for (let i = 0; i < 4; i++) {
            await window.__fx?.raf2()
          }
        })
      await settle()
      const a = clip ? await shoot(page, 'fx-reduced-a', clip) : null
      await page.waitForTimeout(400)
      // A scroll forces frames the held clock must not move.
      await page.evaluate(() => window.scrollBy(0, 1))
      await settle()
      await page.evaluate(() => window.scrollBy(0, -1))
      await settle()
      const b = clip ? await shoot(page, 'fx-reduced-b', clip) : null
      const landed = await page.evaluate(async () => {
        const h = window.__fx
        const el = document.querySelector('[data-vr="fx-off"]')
        if (!h || !el) {
          return false
        }
        const m = h.fx.motion(el, { from: { y: 40 } })
        await m.play({ duration: 5 })
        const ok = m.progress === 1
        m.destroy()
        return ok && h.fx.reducedMotion
      })
      await setEffect(page, 'none')
      await page.evaluate(() => {
        const fx = window.__fx?.fx
        fx?.setReducedMotion(null)
        fx?.__override({
          time: 1.25,
          elapsed: 1.25,
          pointer: { x: 640, y: 450, follow: { x: 640, y: 450 } }
        })
      })
      await settle()
      if (a && b) {
        const n = exactDiff(a, b)
        results.push({
          name: 'fx-reduced (held clock)',
          regressionPct: diffPng(a, b, resolve(outDir, 'fx-reduced-diff.png')),
          status: n === 0 ? 'ok' : 'fail',
          note: `${n} px differ`
        })
      }
      results.push({
        name: 'fx-reduced (play jumps)',
        regressionPct: null,
        status: landed ? 'ok' : 'fail',
        note: landed ? 'progress 1 at once' : 'play() tweened'
      })
    }
    if (want('fx-mat-shared')) {
      // Two materials with the same hooks on different elements, created
      // disabled: warming both compiles one pipeline, and enabling them
      // compiles nothing more.
      const fragment = /* wgsl */ `
        fn fragment(m : MatIn) -> vec4f {
          return m.color * vec4f(0.6, 0.9, 1.0, 1.0);
        }`
      const settle = (): Promise<void> =>
        page.evaluate(async () => {
          const h = window.__fx
          for (let i = 0; h && i < 600 && h.fx.__pending() > 0; i++) {
            await h.raf2()
          }
        })
      const compiled = (): Promise<number> =>
        page.evaluate(() => window.__fx?.fx.__compiled() ?? -1)
      await settle()
      const before = await compiled()
      await page.evaluate((frag) => {
        const h = window.__fx
        const w = window as unknown as Record<string, unknown>
        const mats = []
        for (const id of ['mat-box', 'mat-heading']) {
          const el = document.getElementById(id)
          if (h && el) {
            mats.push(
              h.fx.material({
                name: `shared-${id}`,
                target: el,
                kinds: ['box'],
                fragment: frag,
                enabled: false
              })
            )
          }
        }
        for (const m of mats) {
          m.warm()
        }
        w.__shared = mats
      }, fragment)
      await settle()
      const warmed = (await compiled()) - before
      await page.evaluate(async () => {
        const w = window as unknown as Record<string, unknown>
        for (const m of w.__shared as { enabled: boolean }[]) {
          m.enabled = true
        }
        await window.__fx?.raf2()
        await window.__fx?.raf2()
      })
      await settle()
      const enabled = (await compiled()) - before
      await page.evaluate(async () => {
        const w = window as unknown as Record<string, unknown>
        for (const m of w.__shared as { destroy(): void }[]) {
          m.destroy()
        }
        await window.__fx?.raf2()
      })
      const r = { warmed, enabled }
      results.push({
        name: 'fx-mat-shared',
        regressionPct: null,
        status: r?.warmed === 1 && r.enabled === 1 ? 'ok' : 'fail',
        note: `compiles: warm ${r?.warmed}, after enable ${r?.enabled} (want 1, 1)`
      })
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
    if (want('fx-rgbsplit')) {
      await capture('fx-displace', 'fx-rgbsplit', 'rgb')
    }
    if (want('fx-rgbsplit-pointer')) {
      await capture('fx-displace', 'fx-rgbsplit-pointer', 'rgb-pointer')
    }
    if (want('fx-glitch')) {
      await capture('fx-displace', 'fx-glitch', 'glitch')
    }
    if (want('fx-vignette')) {
      await capture('fx-displace', 'fx-vignette', 'vignette')
    }
    if (want('fx-lens')) {
      await capture('fx-displace', 'fx-lens', 'lens')
    }
    if (want('fx-reveal')) {
      await capture('fx-displace', 'fx-reveal', 'reveal')
    }
    if (want('fx-reveal-0')) {
      await capture('fx-displace', 'fx-reveal-0', 'reveal-0')
    }
    if (want('fx-reveal-then-off')) {
      const s = 'fx-reveal-then-off'
      const pre = await capture('fx-displace', `${s}-pre`, 'none')
      await capture('fx-displace', `${s}-on`, 'reveal')
      const post = await capture('fx-displace', s, 'none')
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
    if (want('fx-p1-then-off')) {
      const s = 'fx-p1-then-off'
      const pre = await capture('fx-displace', `${s}-pre`, 'none')
      await capture('fx-displace', `${s}-on`, 'p1')
      const post = await capture('fx-displace', s, 'none')
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
    const tfs = 'fx-transform'
    const tfInv = [
      'fx-transform-identity',
      'fx-transform-then-off',
      'fx-motion-then-off',
      'fx-dissolve-full'
    ]
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
    if (want('fx-motion') || want('fx-motion-then-off')) {
      const mo = await capture(tfs, 'fx-motion', 'motion')
      const ref = await capture(tfs, 'fx-motion-ref', 'motion-ref')
      if (mo && ref) {
        const n = exactDiff(ref, mo)
        results.push({
          name: 'fx-motion (= ref)',
          regressionPct: diffPng(
            ref,
            mo,
            resolve(outDir, 'fx-motion-ref-invariant.png')
          ),
          status: n === 0 ? 'ok' : 'fail',
          note: `${n} px differ`
        })
      }
    }
    if (want('fx-motion-then-off')) {
      same(
        'fx-motion-then-off',
        await capture(tfs, 'fx-motion-then-off', 'none')
      )
    }
    if (want('fx-dissolve')) {
      await capture(tfs, 'fx-dissolve', 'dissolve')
    }
    if (want('fx-dissolve-full')) {
      same(
        'fx-dissolve-full',
        await capture(tfs, 'fx-dissolve-full', 'dissolve-full')
      )
    }
    await pinPlain()
    await setEffect(page, 'none')

    // Trails: playground/trail.html in replace mode (the source is hidden
    // once ready, so the page shows the GPU output; the clip stops short of
    // the data-gpu-ignore panel). `stroke` deposits a scripted stroke and
    // `hold` keeps it (decay 1).
    const trailShot = async (
      shot: string,
      query: string,
      act?: (p: Page) => Promise<void>
    ): Promise<PNG | null> => {
      const p = await launched.browser.newPage({
        viewport: { width: VW, height: VH },
        deviceScaleFactor: 1,
        reducedMotion: 'reduce'
      })
      p.on('console', (m) => {
        if (m.type() === 'error' && m.text().includes('[compositor-gpu]')) {
          errors.push(`${shot}: ${m.text()}`)
        }
      })
      try {
        await p.goto(`${url}trail.html?${query}`, { waitUntil: 'load' })
        await p.waitForFunction(() => Boolean(window.__trail), null, {
          timeout: 30_000
        })
        const frames = (n: number): Promise<void> =>
          p.evaluate(async (k) => {
            for (let i = 0; i < k; i++) {
              await new Promise((r) => requestAnimationFrame(r))
            }
          }, n)
        await p.evaluate(() => window.__gpu?.ready)
        await frames(10)
        if (act) {
          await act(p)
          await frames(10)
        }
        const panel = await p.evaluate(
          () => document.getElementById('panel')?.getBoundingClientRect().left
        )
        const clip = {
          x: 0,
          y: 0,
          width: Math.floor(panel ?? VW) - 8,
          height: VH
        }
        const path = resolve(outDir, `${shot}-gpu.png`)
        await p.screenshot({ path, clip })
        const png = PNG.sync.read(readFileSync(path))
        results.push(judge(shot, png))
        return png
      } finally {
        await p.close()
      }
    }
    const trailInv = ['fx-trail-clear']
    let trailOff: PNG | null = null
    if (want('fx-trail-off') || trailInv.some(want)) {
      trailOff = await trailShot('fx-trail-off', 'vr')
    }
    if (want('fx-trail')) {
      await trailShot('fx-trail', 'vr&stroke&hold')
    }
    if (want('fx-trail-pixel')) {
      await trailShot('fx-trail-pixel', 'vr&stroke&hold&pixel')
    }
    if (want('fx-trail-reuse')) {
      const reusedIn = async (p: Page): Promise<void> => {
        const r = await p.evaluate(() => window.__gpu?.stats().sceneReused)
        reused.push(r === true)
      }
      const reused: boolean[] = []
      const on = await trailShot(
        'fx-trail-reuse',
        'vr&stroke&hold&passonly',
        reusedIn
      )
      const off = await trailShot(
        'fx-trail-reuse-off',
        'vr&stroke&hold&passonly&noreuse',
        reusedIn
      )
      results.push({
        name: 'fx-trail-reuse (reused)',
        regressionPct: null,
        status: reused[0] === true && reused[1] === false ? 'ok' : 'fail',
        note: `sceneReused on=${reused[0]} off=${reused[1]}`
      })
      if (on && off) {
        const n = exactDiff(off, on)
        results.push({
          name: 'fx-trail-reuse (= off)',
          regressionPct: diffPng(
            off,
            on,
            resolve(outDir, 'fx-trail-reuse-invariant.png')
          ),
          status: n === 0 ? 'ok' : 'fail',
          note: `${n} px differ`
        })
      }
    }
    if (want('fx-trail-clear')) {
      const post = await trailShot(
        'fx-trail-clear',
        'vr&stroke&hold',
        async (p) => {
          await p.evaluate(() => window.__trail?.clear())
        }
      )
      if (trailOff && post) {
        const n = exactDiff(trailOff, post)
        results.push({
          name: 'fx-trail-clear (= off)',
          regressionPct: diffPng(
            trailOff,
            post,
            resolve(outDir, 'fx-trail-clear-invariant.png')
          ),
          status: n === 0 ? 'ok' : 'fail',
          note: `${n} px differ`
        })
      }
    }
    const trShots = [
      'fx-transition-a',
      'fx-transition-0',
      'fx-transition-half',
      'fx-transition-1',
      'fx-transition-b'
    ]
    if (trShots.some(want)) {
      const p = await launched.browser.newPage({
        viewport: { width: VW, height: VH },
        deviceScaleFactor: 1
      })
      p.on('console', (m) => {
        if (m.type() === 'error' && m.text().includes('[compositor-gpu]')) {
          errors.push(`transition: ${m.text()}`)
        }
      })
      try {
        await p.goto(`${url}transition.html?progress=0`, { waitUntil: 'load' })
        await p.waitForFunction(() => Boolean(window.__tr), null, {
          timeout: 30_000
        })
        const frames = (n: number): Promise<void> =>
          p.evaluate(async (k) => {
            for (let i = 0; i < k; i++) {
              await new Promise((r) => requestAnimationFrame(r))
            }
          }, n)
        await frames(10)
        const nav = await p.evaluate(
          () => document.getElementById('nav')?.getBoundingClientRect().top
        )
        const clip = {
          x: 0,
          y: 0,
          width: VW,
          height: Math.floor(nav ?? VH) - 8
        }
        const shot = async (name: string): Promise<PNG> => {
          await frames(4)
          const path = resolve(outDir, `${name}-gpu.png`)
          await p.screenshot({ path, clip })
          const png = PNG.sync.read(readFileSync(path))
          results.push(judge(name, png))
          return png
        }
        const exact = (name: string, a: PNG, b: PNG): void => {
          const n = exactDiff(a, b)
          results.push({
            name: `${name} (exact)`,
            regressionPct: diffPng(
              a,
              b,
              resolve(outDir, `${name}-invariant.png`)
            ),
            status: n === 0 ? 'ok' : 'fail',
            note: `${n} px differ`
          })
        }
        const a = await shot('fx-transition-a')
        // Swaps to state 1 and holds the reveal at progress 0.
        await p.evaluate(() => window.__tr?.go(1, [0.3, 0.45]))
        exact('fx-transition-0', a, await shot('fx-transition-0'))
        await p.evaluate(() => {
          const r = window.__tr?.reveal
          if (r) {
            ;(r.params as Record<string, number>).progress = 0.5
          }
        })
        await shot('fx-transition-half')
        await p.evaluate(() => {
          const r = window.__tr?.reveal
          if (r) {
            ;(r.params as Record<string, number>).progress = 1
          }
        })
        const one = await shot('fx-transition-1')
        await p.evaluate(() => window.__tr?.reveal.end())
        exact('fx-transition-1', await shot('fx-transition-b'), one)
      } finally {
        await p.close()
      }
    }
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
