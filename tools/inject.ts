// Injecting the library into a page it isn't installed on: a
// self-contained ES-module build of `src/index.ts` (typegpu and
// opentype.js bundled in), served same-origin through Playwright routing
// and loaded as a module that puts `createCompositor` on the window.
// Shared by the site-parity harness (test/site/run.ts) and the profiler
// CLI (tools/profile.ts).

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const BUNDLE_ROUTE = '/__compositor-gpu-inject__.js'

export function newestMtimeMs(dir: string): number {
  let max = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name)
    max = Math.max(
      max,
      entry.isDirectory() ? newestMtimeMs(p) : statSync(p).mtimeMs
    )
  }
  return max
}

/** Build (or reuse, when nothing under src/ is newer) the inject bundle
 * in `outDir`; returns its path. `label` prefixes the log lines. */
export async function ensureInjectBundle(
  outDir: string,
  label = 'inject'
): Promise<string> {
  mkdirSync(outDir, { recursive: true })
  const bundlePath = resolve(outDir, 'compositor-gpu.inject.js')
  const srcMtime = newestMtimeMs(resolve(root, 'src'))
  if (existsSync(bundlePath) && statSync(bundlePath).mtimeMs > srcMtime) {
    console.log(`[${label}] using cached inject bundle (${bundlePath})`)
    return bundlePath
  }
  console.log(`[${label}] building self-contained inject bundle...`)
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    resolve: { alias: { '@': resolve(root, 'src') } },
    // typegpu reads `globalThis.process.env.NODE_ENV` directly (not the bare
    // `process.env.NODE_ENV` Vite's own define matches) — bundled in for
    // injection, that throws on a page with no Node `process` global.
    define: {
      'globalThis.process.env.NODE_ENV': JSON.stringify('production'),
      'process.env.NODE_ENV': JSON.stringify('production')
    },
    build: {
      lib: {
        entry: resolve(root, 'src/index.ts'),
        formats: ['es'],
        fileName: () => 'compositor-gpu.inject.js'
      },
      outDir,
      emptyOutDir: false,
      // One file: the route serves only the entry, so no chunks (the
      // library loads its renderer by dynamic import).
      rollupOptions: { external: [], output: { codeSplitting: false } },
      sourcemap: false,
      target: 'esnext'
    }
  })
  return bundlePath
}

/** Route `BUNDLE_ROUTE` on `page` to the built bundle (same-origin, so a
 * default `script-src 'self'` CSP still allows it) and load it as a module,
 * exposing `createCompositor` on `window.__createCompositor`. */
export async function injectBundle(
  page: Page,
  bundlePath: string
): Promise<void> {
  await page.route(`**${BUNDLE_ROUTE}`, (route) =>
    route.fulfill({ path: bundlePath, contentType: 'text/javascript' })
  )
  await page.addScriptTag({
    type: 'module',
    content: `
      const mod = await import(${JSON.stringify(BUNDLE_ROUTE)})
      window.__createCompositor = mod.createCompositor
    `
  })
  await page.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __createCompositor?: unknown })
          .__createCompositor
      ),
    null,
    { timeout: 30_000 }
  )
}
