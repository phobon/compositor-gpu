import { inert } from './compositor_inert'
import type { Scene } from './scene/scene'
import type { SlugText } from './text/slug/rasterizer'
import type { Compositor, CompositorOptions } from './types'
import { log } from './util/log'

// The package entry's createCompositor. It loads the renderer (and with
// it opentype.js, typegpu and every pass) only when the browser has
// WebGPU, so a page enhanced by the compositor costs a visitor without
// WebGPU this module and the inert compositor, nothing more.

/**
 * Create a compositor that mirrors `root` onto a GPU canvas overlay. Async
 * because WebGPU device init (and loading the renderer) is async. Never
 * throws in 'passthrough' fallback: without WebGPU you get an inert
 * compositor and the untouched page.
 */
export async function createCompositor(
  options: CompositorOptions = {}
): Promise<Compositor & { text: SlugText | null; scene: Scene | null }> {
  if (!(await hasAdapter())) {
    if (options.fallback === 'throw') {
      throw new Error('[compositor-gpu] WebGPU unavailable')
    }
    log.warn('WebGPU not available; passthrough')
    return inert()
  }
  const { createCompositor: create } = await import('./compositor')
  return create(options)
}

// navigator.gpu present is not enough: a blocklisted or disabled GPU has
// the API but no adapter. Asking for one here (the renderer asks again
// for its device) keeps those browsers on the inert path too.
async function hasAdapter(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return false
  }
  try {
    return (await navigator.gpu.requestAdapter()) !== null
  } catch {
    return false
  }
}
