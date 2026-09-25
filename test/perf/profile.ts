// Profiles 5 full DOM reads with Chromium's CPU profiler (via CDP) and
// writes the top-25 self-time entries to test/perf/out/profile.txt. Not a
// gating check — a one-off tool for Task 3's cost breakdown.
//
// Usage: npx tsx test/perf/profile.ts [--n 400]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser } from 'playwright'
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

interface CallFrame {
  functionName: string
  scriptId: string
  url: string
  lineNumber: number
  columnNumber: number
}
interface CpuProfileNode {
  id: number
  callFrame: CallFrame
  hitCount?: number
  children?: number[]
}
interface CpuProfile {
  nodes: CpuProfileNode[]
  startTime: number
  endTime: number
  samples?: number[]
  timeDeltas?: number[]
}

/** A stable label for a call frame, grouping by function + source location
 * (not by profiler node id, which can differ per call site/inlining). */
function labelFor(cf: CallFrame): string {
  const url = cf.url
  const name = cf.functionName || '(anonymous)'
  if (!url) {
    return `(native) ${name}`
  }
  const srcIdx = url.indexOf('/src/')
  if (srcIdx !== -1) {
    return `${url.slice(srcIdx + 1)}:${cf.lineNumber + 1} ${name}`
  }
  return `${name} [${url.split('/').pop()}:${cf.lineNumber + 1}]`
}

function isNativeApi(name: string): string | null {
  const natives = [
    'getComputedStyle',
    'getBoundingClientRect',
    'getClientRects',
    'createRange',
    'measureText',
    'Segmenter'
  ]
  for (const n of natives) {
    if (name.includes(n)) {
      return n
    }
  }
  return null
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
    console.log(`[profile] vite dev server at ${url}`)

    const { browser: b, usedSwiftshader } = await launchWithFallback(
      url,
      'profile'
    )
    browser = b
    console.log(
      `[profile] chromium launched (${usedSwiftshader ? 'swiftshader' : 'native'}), n=${n}`
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

    const session = await page.context().newCDPSession(page)
    await session.send('Profiler.enable')
    await session.send('Profiler.setSamplingInterval', { interval: 100 })
    await session.send('Profiler.start')

    for (let i = 0; i < 5; i++) {
      await page.evaluate(async () => {
        window.__perf?.invalidate()
        await new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r()))
        )
      })
    }

    const { profile } = (await session.send('Profiler.stop')) as {
      profile: CpuProfile
    }

    const selfMs = new Map<number, number>()
    const samples = profile.samples ?? []
    const deltas = profile.timeDeltas ?? []
    for (let i = 0; i < samples.length; i++) {
      const id = samples[i]
      const dt = (deltas[i] ?? 0) / 1000
      if (id === undefined) {
        continue
      }
      selfMs.set(id, (selfMs.get(id) ?? 0) + dt)
    }
    const nodeById = new Map(profile.nodes.map((nd) => [nd.id, nd]))

    const byLabel = new Map<string, number>()
    for (const [id, ms] of selfMs) {
      const node = nodeById.get(id)
      if (!node) {
        continue
      }
      const label = labelFor(node.callFrame)
      byLabel.set(label, (byLabel.get(label) ?? 0) + ms)
    }

    const total = [...byLabel.values()].reduce((a, b) => a + b, 0)
    const ranked = [...byLabel.entries()].sort((a, b) => b[1] - a[1])
    const top25 = ranked.slice(0, 25)

    // Native-API rollup (getComputedStyle / getBoundingClientRect / Range /
    // measureText), independent of the per-frame top-25 list above.
    const nativeMs = new Map<string, number>()
    for (const [id, ms] of selfMs) {
      const node = nodeById.get(id)
      if (!node) {
        continue
      }
      const api = isNativeApi(node.callFrame.functionName)
      if (api) {
        nativeMs.set(api, (nativeMs.get(api) ?? 0) + ms)
      }
    }

    const lines: string[] = []
    lines.push(
      `profile: 5 full reads, n=${n} cards (${new Date().toISOString()})`
    )
    lines.push(`total sampled self time: ${total.toFixed(2)}ms`)
    lines.push('')
    lines.push('top 25 by self time:')
    lines.push('rank  self ms   pct   function')
    lines.push('----------------------------------------------------------')
    top25.forEach(([label, ms], i) => {
      const pct = total > 0 ? ((ms / total) * 100).toFixed(1) : '0.0'
      lines.push(
        `${String(i + 1).padStart(4)}  ${ms.toFixed(2).padStart(7)}  ${pct.padStart(4)}%  ${label}`
      )
    })
    lines.push('')
    lines.push('native API rollup:')
    for (const [api, ms] of [...nativeMs.entries()].sort(
      (a, b) => b[1] - a[1]
    )) {
      const pct = total > 0 ? ((ms / total) * 100).toFixed(1) : '0.0'
      lines.push(`  ${api.padEnd(24)} ${ms.toFixed(2).padStart(8)}ms  ${pct}%`)
    }

    const text = lines.join('\n')
    writeFileSync(resolve(outDir, 'profile.txt'), `${text}\n`)
    console.log(text)
  } finally {
    await browser?.close()
    await server?.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
