import { BoxPass } from './boxes/boxRenderer'
import { Dirty, DomSync } from './dom/observer'
import { readSubtree } from './dom/walker'
import { initGpu } from './gpu/device'
import { Renderer } from './gpu/renderer'
import { ImagePass } from './images/imageRenderer'
import { Scene } from './scene/scene'
import { SlugText } from './text/slug/rasterizer'
import type {
  Compositor,
  CompositorOptions,
  FrameContext,
  Layer
} from './types'
import { log, setDebug } from './util/log'
import { FrameScheduler } from './util/raf'

/**
 * Create a compositor that mirrors `root` onto a GPU canvas overlay. Async
 * because WebGPU device init is async. Never throws in 'passthrough' fallback:
 * if WebGPU is unavailable you get an inert compositor and the untouched page.
 */
export async function createCompositor(
  options: CompositorOptions = {}
): Promise<Compositor & { text: SlugText | null }> {
  const root = options.root ?? document.body
  const layers = new Set<Layer>(options.layers ?? ['boxes', 'images', 'text'])
  const fallback = options.fallback ?? 'passthrough'
  setDebug(Boolean(options.debug))

  const canvas = document.createElement('canvas')
  Object.assign(canvas.style, {
    position: 'fixed',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    zIndex: '2147483646'
  } satisfies Partial<CSSStyleDeclaration>)
  canvas.setAttribute('aria-hidden', 'true')
  document.body.appendChild(canvas)

  const gpu = await initGpu(canvas)
  if (!gpu) {
    canvas.remove()
    if (fallback === 'throw')
      throw new Error('[compositor-gpu] WebGPU unavailable')
    return inert()
  }

  const dpr = options.devicePixelRatio ?? window.devicePixelRatio ?? 1
  const renderer = new Renderer(gpu)
  if (layers.has('boxes')) renderer.addPass(new BoxPass(renderer.shared))
  if (layers.has('images')) renderer.addPass(new ImagePass())
  let text: SlugText | null = null
  if (layers.has('text')) {
    text = new SlugText(renderer.shared)
    renderer.addPass(text)
    if (options.fonts && options.fonts !== 'auto') {
      void text.prepare(options.fonts)
    }
  }

  const scene = new Scene()
  let pendingReadFlags = Dirty.ALL
  const animating = Boolean(options.onGlyph || options.onFrame)

  const resizeCanvas = (): void => {
    canvas.width = Math.floor(window.innerWidth * dpr)
    canvas.height = Math.floor(window.innerHeight * dpr)
  }
  resizeCanvas()

  const frame = (time: number, dt: number): void => {
    const flags = sync.take() | pendingReadFlags
    pendingReadFlags = Dirty.NONE

    if (flags & Dirty.LAYOUT) resizeCanvas()
    if (flags & (Dirty.LAYOUT | Dirty.STYLE | Dirty.CONTENT)) {
      readSubtree(root, scene, layers)
    }

    const ctx: FrameContext = {
      time,
      dt,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight
    }

    if (options.onGlyph) {
      for (const run of scene.runs) {
        for (const g of run.glyphs) options.onGlyph(g, ctx)
      }
      // offsets changed -> re-upload instances. v1 uses a scene-wide dirty; a
      // per-layer dirty flag is a cheap follow-up (ROADMAP §Sync).
      scene.dirty = true
    }
    options.onFrame?.(ctx)

    renderer.render(scene, ctx, dpr)
    if (animating) scheduler.request()
  }

  const scheduler = new FrameScheduler(frame)
  const sync = new DomSync(root, () => scheduler.request())
  const onResize = (): void => {
    pendingReadFlags |= Dirty.LAYOUT
    scheduler.request()
  }

  log.info(`compositor ready — layers: ${[...layers].join(', ')}`)

  return {
    active: true,
    text,
    start() {
      scheduler.start()
      sync.start()
      window.addEventListener('resize', onResize)
    },
    stop() {
      scheduler.stop()
      sync.stop()
      window.removeEventListener('resize', onResize)
    },
    invalidate() {
      pendingReadFlags = Dirty.ALL
      scheduler.request()
    },
    destroy() {
      scheduler.stop()
      sync.stop()
      window.removeEventListener('resize', onResize)
      renderer.destroy()
      gpu.root.destroy()
      canvas.remove()
    }
  }
}

function inert(): Compositor & { text: null } {
  return {
    active: false,
    text: null,
    start() {},
    stop() {},
    invalidate() {},
    destroy() {}
  }
}
