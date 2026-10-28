// The HTML report for `npm run profile` (tools/profile.ts;
// docs/PROFILER.md, M6d): one self-contained file that opens anywhere,
// the standalone viewer (src/devtools/viewer.ts, built once into a
// script and cached until src/ changes) with the recording gzipped and
// base64-encoded inside it, and the budget's verdict and the baseline
// comparison beside it.

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { newestMtimeMs } from '../inject'
import type { BudgetRow } from './budget'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** The viewer as one IIFE script (global `CompositorGpuViewer`). */
export async function viewerScript(): Promise<string> {
  const dir = resolve(tmpdir(), 'compositor-gpu-viewer')
  mkdirSync(dir, { recursive: true })
  const out = resolve(dir, 'viewer.js')
  if (
    !existsSync(out) ||
    statSync(out).mtimeMs < newestMtimeMs(resolve(root, 'src'))
  ) {
    await build({
      root,
      configFile: false,
      logLevel: 'warn',
      build: {
        lib: {
          entry: resolve(root, 'src/devtools/viewer_entry.ts'),
          formats: ['iife'],
          name: 'CompositorGpuViewer',
          fileName: () => 'viewer.js'
        },
        outDir: dir,
        emptyOutDir: false,
        sourcemap: false,
        target: 'es2022',
        minify: true
      }
    })
  }
  return readFileSync(out, 'utf8')
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  )

/** The report page: `gz` is the encoded recording (encodeRecording). */
export async function reportHtml(
  title: string,
  gz: Uint8Array,
  budget: BudgetRow[] | null,
  baseline: string[] | null
): Promise<string> {
  const script = await viewerScript()
  const data = Buffer.from(gz).toString('base64')
  const opts = JSON.stringify({
    budget: budget ?? undefined,
    baseline: baseline ?? undefined
  }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>html, body { margin: 0; background: #111114; color-scheme: dark; }</style>
</head>
<body>
<script id="recording" type="application/octet-stream">${data}</script>
<script id="options" type="application/json">${opts}</script>
<script>${script.replace(/<\/script/gi, '<\\/script')}</script>
<script>
(async () => {
  const b64 = document.getElementById('recording').textContent.trim()
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const opts = JSON.parse(document.getElementById('options').textContent)
  const rec = await CompositorGpuViewer.decodeRecording(bytes)
  CompositorGpuViewer.mountViewer(document.body, rec, opts)
})().catch((e) => {
  document.body.textContent = 'Could not open the recording: ' + e.message
})
</script>
</body>
</html>
`
}
