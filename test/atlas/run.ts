// Image atlas harness: loads playground/atlas.html, which runs ImageAtlas
// checks in the page (growth keeps pixels, a full atlas repacks the space
// a grow wasted, unused entries are evicted when new ones need room and
// the survivors keep their pixels) and prints them.
//
// Usage: npm run test:atlas
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser } from 'playwright'
import { createServer, type ViteDevServer } from 'vite'
import { launchWithFallback } from '../lib/browser'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

type Check = [string, boolean, string]

async function main(): Promise<void> {
  let server: ViteDevServer | null = null
  let browser: Browser | null = null
  let checks: Check[] = []
  const errors: string[] = []
  try {
    server = await createServer({
      configFile: resolve(root, 'vite.config.ts'),
      server: { port: 0, open: false, strictPort: false }
    })
    await server.listen()
    const base = server.resolvedUrls?.local[0]
    if (!base) {
      throw new Error('vite dev server produced no resolved URL')
    }
    const url = `${base}atlas.html`
    const launched = await launchWithFallback(url, 'atlas')
    browser = launched.browser
    const page = await browser.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(url)
    await page.waitForFunction(() => '__atlas' in window)
    checks = await page.evaluate(
      () => (window as unknown as { __atlas: Promise<Check[]> }).__atlas
    )
  } finally {
    await browser?.close()
    await server?.close()
  }
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(34)} ${detail}`)
  }
  if (errors.length > 0) {
    console.log(`\n[atlas] page errors:\n  ${errors.join('\n  ')}`)
  }
  if (errors.length > 0 || checks.length === 0 || checks.some((c) => !c[1])) {
    console.error('\n[atlas] FAILED')
    process.exit(1)
  }
  console.log('\n[atlas] OK')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
