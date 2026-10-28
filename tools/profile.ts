// `npm run profile -- <url>`: profile a site in a real browser
// (docs/PROFILER.md, M6d). Opens the page in Chrome (headed, so the real
// GPU and display refresh; --headless for CI), finds its compositor (the
// page's own, as `window.__gpu`, or one injected over it with
// --inject), records while it runs a scenario (by default: scroll to the
// bottom and back), then writes
//
//   recording.cgprof   the recording (open it in the devtools: Import)
//   report.html        a self-contained viewer: Timeline with each late
//                      frame explained, Elements, the budget, the
//                      baseline comparison
//   summary.txt        what it prints: percentiles, the worst hitches
//                      with their factors, the budget, the comparison
//
// and exits 1 when a budget is exceeded.
//
// Usage:
//   npm run profile -- https://localhost:8000/duo?gpu=1
//   npm run profile -- <url> --scenario duo.json       steps, budget, viewport
//   npm run profile -- <url> --click "#next" --click "#next"
//   npm run profile -- <url> --steps '[{"scroll":"#showcase"},{"wait":3000}]'
//   npm run profile -- <url> --inject --root "#app" --mode replace
//   npm run profile -- <url> --budget budget.json --baseline before.cgprof
// Options:
//   --scroll          scroll down and back (the default with no steps);
//                     --speed px per frame (12)
//   --wait ms         settle before recording (1500)
//   --global name     the page's compositor on window (__gpu)
//   --headless        no window (SwiftShader when there's no GPU: GPU and
//                     pacing numbers then describe it, not the machine)
//   --channel         chrome (default), chrome-canary, msedge, chromium
//   --viewport WxH    1280x900; --dpr (1; a Retina display is 2)
//   --out dir         profile-out/<name>-<time>
//   --title text      the report's title
// From another project: `npx tsx path/to/compositor-gpu/tools/profile.ts`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Browser, chromium } from 'playwright'
import { formatReport, type ProfileReport } from '../src/profile/profiler'
import {
  decodeRecording,
  encodeRecording,
  toRecording
} from '../src/profile/recording'
import { launchWithFallback } from '../test/lib/browser'
import { ensureInjectBundle, injectBundle } from './inject'
import {
  type Budget,
  type BudgetRow,
  checkBudget,
  formatBudget
} from './profile/budget'
import { compareReports } from './profile/compare'
import { reportHtml } from './profile/html'
import {
  runSteps,
  type Scenario,
  type Step,
  scrollScenario,
  validateSteps
} from './profile/scenario'

const argv = process.argv.slice(2)
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const args = (name: string): string[] =>
  argv.flatMap((a, i) =>
    a === `--${name}` && argv[i + 1] ? [argv[i + 1] as string] : []
  )
const flag = (name: string): boolean => argv.includes(`--${name}`)
/** Options that take a value (the rest are switches). */
const VALUE_FLAGS = [
  'scenario',
  'steps',
  'click',
  'speed',
  'wait',
  'global',
  'channel',
  'viewport',
  'dpr',
  'out',
  'title',
  'root',
  'mode',
  'budget',
  'baseline'
]
const log = (s: string): void => console.log(`[profile] ${s}`)

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(resolve(path), 'utf8')) as T

async function main(): Promise<void> {
  const scenarioPath = arg('scenario')
  const scenario: Scenario = scenarioPath
    ? readJson<Scenario>(scenarioPath)
    : { steps: [] }
  const valued = new Set(
    argv.flatMap((a, i) =>
      VALUE_FLAGS.includes(a.replace(/^--/, '')) ? [i + 1] : []
    )
  )
  const url =
    argv.find((a, i) => !a.startsWith('--') && !valued.has(i)) ?? scenario.url
  if (!url) {
    console.error(
      'usage: npm run profile -- <url> [--scenario file.json] [--scroll] [--click sel] [--budget file.json] [--baseline file.cgprof] [--headless] ...'
    )
    process.exit(2)
  }
  let steps: Step[] = scenario.steps ? validateSteps(scenario.steps) : []
  const inline = arg('steps')
  if (inline) {
    steps = validateSteps(JSON.parse(inline))
  }
  for (const sel of args('click')) {
    steps.push({ click: sel }, { wait: 1500 })
  }
  for (const f of ['baseline', 'budget', 'scenario']) {
    const v = arg(f)
    if (v && !existsSync(resolve(v))) {
      console.error(`[profile] --${f}: no file at ${resolve(v)}`)
      process.exit(2)
    }
  }
  const speed = Number(arg('speed') ?? 12)
  if (flag('scroll') || steps.length === 0) {
    steps.push(...scrollScenario(speed))
  }
  const budget: Budget | null = arg('budget')
    ? readJson<Budget>(arg('budget') as string)
    : (scenario.budget ?? null)
  const [vw, vh] = (arg('viewport') ?? '')
    .split('x')
    .map(Number)
    .filter((n) => n > 0)
  const viewport = {
    width: vw ?? scenario.viewport?.[0] ?? 1280,
    height: vh ?? scenario.viewport?.[1] ?? 900
  }
  const dpr = Number(arg('dpr') ?? scenario.dpr ?? 1)
  const global = arg('global') ?? '__gpu'
  const name =
    scenario.name ??
    (new URL(url).pathname.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'page')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = resolve(arg('out') ?? `profile-out/${name}-${stamp}`)
  mkdirSync(outDir, { recursive: true })

  // The browser: headed Chrome by default (the real GPU and refresh).
  // Precise GPU timestamps (Chrome rounds them to 100 µs otherwise).
  const timing = ['--enable-webgpu-developer-features']
  const gpuArgs = ['--enable-unsafe-webgpu', ...timing]
  let browser: Browser
  let software = false
  if (flag('headless')) {
    // Probes for a real adapter, else SwiftShader (which adds
    // --enable-unsafe-webgpu itself: on the probe it would find a broken
    // one).
    const l = await launchWithFallback(url, 'profile', timing)
    browser = l.browser
    software = l.usedSwiftshader
  } else {
    const channel = arg('channel') ?? 'chrome'
    const opts = { headless: false, args: gpuArgs }
    try {
      browser = await chromium.launch({
        ...opts,
        ...(process.env.CHROMIUM_PATH
          ? { executablePath: process.env.CHROMIUM_PATH }
          : channel === 'chromium'
            ? {}
            : { channel })
      })
    } catch (e) {
      log(
        `couldn't launch ${channel} (${(e as Error).message.split('\n')[0]}); using Playwright's Chromium`
      )
      browser = await chromium.launch(opts)
    }
  }
  log(`browser ${browser.version()}${flag('headless') ? ' (headless)' : ''}`)
  let exit = 0
  try {
    const page = await browser.newPage({ viewport, deviceScaleFactor: dpr })
    await page.addInitScript('globalThis.__name = (f) => f')
    page.on('pageerror', (e) => console.error('[page]', e.message))
    log(`open ${url}`)
    await page.goto(url, { waitUntil: 'load' })

    if (flag('inject')) {
      const bundle = await ensureInjectBundle(
        resolve(outDir, '..', '.cache'),
        'profile'
      )
      await injectBundle(page, bundle)
      await page.evaluate(
        async ({ root, mode, global }) => {
          const w = window as unknown as Record<string, unknown> & {
            __createCompositor: (o: unknown) => Promise<{ start(): void }>
          }
          const c = await w.__createCompositor({
            root: document.querySelector(root) ?? document.body,
            mode,
            fonts: 'auto'
          })
          c.start()
          w[global] = c
        },
        { root: arg('root') ?? 'body', mode: arg('mode') ?? 'overlay', global }
      )
    }
    try {
      await page.waitForFunction(
        (g) => Boolean((window as unknown as Record<string, unknown>)[g]),
        global,
        { timeout: 60_000 }
      )
    } catch {
      throw new Error(
        `no compositor on window.${global} after 60 s: does the page mount one (the React provider's \`global\`, a ?gpu=1 flag)? Or use --inject.`
      )
    }
    const state = await page.evaluate(async (g) => {
      const c = (window as unknown as Record<string, unknown>)[g] as {
        active: boolean
        ready?: Promise<void>
      }
      if (c.active) {
        await c.ready
      }
      const a = await navigator.gpu?.requestAdapter()
      return {
        active: c.active,
        adapter: a
          ? `${a.info.vendor} ${a.info.architecture} ${a.info.description}`.trim()
          : null,
        fallback:
          (a?.info as { isFallbackAdapter?: boolean } | undefined)
            ?.isFallbackAdapter === true
      }
    }, global)
    if (!state.active) {
      throw new Error(
        `the compositor on window.${global} is inactive (no WebGPU adapter in this browser: ${state.adapter ?? 'none'})`
      )
    }
    software ||= state.fallback || /swiftshader/i.test(state.adapter ?? '')
    log(
      `adapter ${state.adapter ?? 'unknown'}${software ? ' — SOFTWARE: GPU and pacing numbers describe it, not this machine' : ''}`
    )
    await page.waitForTimeout(Number(arg('wait') ?? 1500))

    // Record the scenario.
    await page.evaluate((g) => {
      ;(window as unknown as Record<string, { profile: { start(): void } }>)[
        g
      ]?.profile.start()
    }, global)
    await runSteps(page, steps, global, (s) => log(`  ${s}`))
    const report = (await page.evaluate(
      (g) =>
        (
          window as unknown as Record<
            string,
            { profile: { stop(): Promise<unknown> } }
          >
        )[g]?.profile.stop(),
      global
    )) as ProfileReport | null
    if (!report || report.samples.length === 0) {
      throw new Error(
        'the recording has no frames (did anything change on the page?)'
      )
    }

    // Write and print.
    const title = arg('title') ?? `${name} — ${new Date().toLocaleString()}`
    const recording = toRecording(report, 'recording', title)
    const gz = await encodeRecording(recording)
    writeFileSync(resolve(outDir, 'recording.cgprof'), gz)
    const rows: BudgetRow[] | null = budget ? checkBudget(report, budget) : null
    let baseline: string[] | null = null
    const basePath = arg('baseline')
    if (basePath) {
      const base = await decodeRecording(readFileSync(resolve(basePath)))
      baseline = compareReports(report, base.report)
    }
    writeFileSync(
      resolve(outDir, 'report.html'),
      await reportHtml(title, gz, rows, baseline)
    )
    // formatReport's own hitch lines give way to the factors below.
    const lines = [
      ...formatReport(report, name)
        .split('\n')
        .filter((l) => !l.startsWith('  hitch ')),
      ''
    ]
    for (const h of report.hitches.slice(0, 6)) {
      lines.push(
        `late +${(h.at / 1000).toFixed(2)} s: ${h.dt.toFixed(1)} ms gap, ${h.missed} missed`
      )
      for (const f of (h.factors ?? []).slice(0, 4)) {
        lines.push(
          `    ${f.kind.padEnd(12)} ${f.ms.toFixed(1).padStart(7)} ms  ${f.text}${f.source ? `  <${f.source}>` : ''}`
        )
      }
    }
    if (rows) {
      lines.push('', 'budget', formatBudget(rows))
      if (rows.some((r) => !r.ok)) {
        exit = 1
      }
    }
    if (baseline) {
      lines.push('', `against ${basePath}`, ...baseline.map((l) => `  ${l}`))
    }
    if (software) {
      lines.push(
        '',
        '(software adapter: GPU and pacing numbers describe SwiftShader, not this machine)'
      )
    }
    const summary = lines.join('\n')
    writeFileSync(resolve(outDir, 'summary.txt'), `${summary}\n`)
    console.log(`\n${summary}\n`)
    log(`wrote ${outDir}/report.html, recording.cgprof, summary.txt`)
    if (exit) {
      log('over budget')
    }
  } finally {
    if (!flag('keep')) {
      await browser.close()
    }
  }
  process.exitCode = exit
}

main().catch((e: unknown) => {
  console.error(`[profile] ${(e as Error).message}`)
  process.exit(1)
})
