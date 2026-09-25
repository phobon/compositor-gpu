// Shared headless-Chromium launch: try the real GPU adapter first, fall back
// to SwiftShader (software WebGPU) so the harnesses also run in a sandbox
// with no GPU. Used by test/visual/run.ts and test/perf/run.ts.
import { type Browser, chromium, type Page } from 'playwright'

export const SWIFTSHADER_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=swiftshader',
  '--use-vulkan=swiftshader',
  '--ignore-gpu-blocklist'
]

async function waitForAdapter(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    if (!navigator.gpu) {
      return false
    }
    const adapter = await navigator.gpu.requestAdapter()
    return adapter !== null
  })
}

/**
 * Launch Chromium against `url`, preferring a real GPU adapter; falls back
 * to SwiftShader args when none is available. `label` prefixes console logs
 * so callers with different harness names stay distinguishable.
 */
export async function launchWithFallback(
  url: string,
  label = 'browser'
): Promise<{ browser: Browser; usedSwiftshader: boolean }> {
  const executablePath = process.env.CHROMIUM_PATH || undefined
  const launchOpts = { executablePath } as const

  const probe = await chromium.launch({ ...launchOpts, args: [] })
  try {
    const page = await probe.newPage()
    // Needs a secure context, so probe against the real dev-server origin
    // rather than about:blank.
    await page.goto(url)
    const hasAdapter = await waitForAdapter(page)
    await page.close()
    if (hasAdapter) {
      console.log(`[${label}] using native GPU adapter (no swiftshader args)`)
      return { browser: probe, usedSwiftshader: false }
    }
  } catch (e) {
    console.log(`[${label}] native GPU probe failed:`, (e as Error).message)
  }
  await probe.close()

  console.log(`[${label}] falling back to swiftshader (software WebGPU)`)
  const browser = await chromium.launch({
    ...launchOpts,
    args: SWIFTSHADER_ARGS
  })
  return { browser, usedSwiftshader: true }
}
