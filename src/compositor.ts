import { BoxPass } from './boxes/boxRenderer'
import { Dirty, DomSync } from './dom/observer'
import { SceneReader } from './dom/tree'
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
  const mode = options.mode ?? 'overlay'
  const hideSource = options.hideSource ?? true
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
  // Mount on <html>, not <body>: replace mode hides the mirrored root's
  // paint via opacity, and the canvas must never be a descendant of it.
  document.documentElement.appendChild(canvas)

  const gpu = await initGpu(canvas)
  if (!gpu) {
    canvas.remove()
    if (fallback === 'throw')
      throw new Error('[compositor-gpu] WebGPU unavailable')
    return inert()
  }

  const dpr = options.devicePixelRatio ?? window.devicePixelRatio ?? 1
  gpu.device.pushErrorScope('validation')
  const renderer = new Renderer(gpu)
  if (layers.has('boxes')) renderer.addPass(new BoxPass(renderer.shared))
  if (layers.has('images')) renderer.addPass(new ImagePass(renderer.shared))
  let text: SlugText | null = null
  if (layers.has('text')) {
    text = new SlugText(renderer.shared)
    renderer.addPass(text)
  }
  gpu.device.popErrorScope().then((e) => {
    if (e) log.error('GPU validation error during setup:', e.message)
  })

  const scene = new Scene()
  // `sync` is declared after `reader` (it needs `scheduler`, declared after
  // `reader` too), so this closes over the `sync` binding lazily — it's
  // only invoked once an asset load fires, well after `sync` exists.
  const reader = new SceneReader(root, scene, layers, (el) =>
    sync.invalidateScope(el)
  )
  let pendingReadFlags = Dirty.ALL
  const animating = Boolean(options.onGlyph || options.onFrame)
  let fps = 0
  let readMs = 0

  const resizeCanvas = (): void => {
    canvas.width = Math.floor(window.innerWidth * dpr)
    canvas.height = Math.floor(window.innerHeight * dpr)
  }
  resizeCanvas()

  const frame = (time: number, dt: number): void => {
    const dirty = sync.take()
    let flags = dirty.flags | pendingReadFlags
    pendingReadFlags = Dirty.NONE
    // Running CSS transitions/animations fire no mutation records: re-read
    // their scopes every frame while any run (dirty.scopes is ours until
    // the next take()).
    let cssAnimating = false
    const scopes = dirty.scopes as Set<Element>
    for (const el of sync.animatingScopes()) {
      scopes.add(el)
      cssAnimating = true
    }
    if (cssAnimating) flags |= Dirty.MUTATION

    if (flags & Dirty.LAYOUT) resizeCanvas()
    if (flags & (Dirty.LAYOUT | Dirty.STYLE | Dirty.CONTENT)) {
      const t0 = performance.now()
      reader.fullRead()
      readMs = performance.now() - t0
    } else if (flags & Dirty.MUTATION) {
      const t0 = performance.now()
      reader.partialRead(dirty.scopes)
      readMs = performance.now() - t0
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
      // Only glyph offsets changed: re-upload just the text layer.
      scene.markDirty('text')
    }
    // A live <video>/<canvas> changes without a DOM mutation: re-upload just the
    // image layer (which re-copies its texture) and keep the loop running.
    if (scene.hasDynamic) scene.markDirty('images')
    options.onFrame?.(ctx)

    // The swapchain texture can't be created at 0x0 (e.g. before the canvas
    // has laid out, when innerWidth is briefly 0). Skip the frame; a resize
    // re-requests one once the viewport has a size.
    if (canvas.width === 0 || canvas.height === 0) {
      if (animating || scene.hasDynamic || cssAnimating) scheduler.request()
      return
    }

    if (dt > 0) fps = fps ? fps * 0.9 + 0.1 / dt : 1 / dt
    renderer.render(scene, ctx, dpr)
    if (animating || scene.hasDynamic || cssAnimating) scheduler.request()
  }

  const scheduler = new FrameScheduler(frame)
  const sync = new DomSync(root, () => scheduler.request())

  if (text) {
    // 'auto' (and, for convenience, the default) discovers the document's
    // registered faces; an explicit list resolves just those. Either way the
    // bytes are fetched at runtime, then a re-read re-uploads the glyphs.
    const faces =
      options.fonts && options.fonts !== 'auto'
        ? options.fonts
        : options.fonts === 'auto'
          ? Array.from(document.fonts)
          : []
    if (faces.length > 0) {
      void text.prepare(faces).then(() => {
        pendingReadFlags |= Dirty.STYLE
        scheduler.request()
      })
    }
  }
  const onResize = (): void => {
    pendingReadFlags |= Dirty.LAYOUT
    scheduler.request()
  }
  // Positions are absolute document space, so scrolling only needs a re-render
  // (updated frame.scroll), not a re-read. Essential once the GPU IS the paint.
  const onScroll = (): void => scheduler.request()

  // Replace mode: hide the mirrored root's own paint while keeping its layout,
  // focus, selection, hit-testing and a11y tree intact (opacity leaves all of
  // those untouched). Reversible; the GPU canvas provides the pixels.
  let sourceHidden = false
  let savedOpacity = ''
  const setSourceHidden = (hidden: boolean): void => {
    if (hidden === sourceHidden || !(root instanceof HTMLElement)) return
    sourceHidden = hidden
    if (hidden) {
      savedOpacity = root.style.opacity
      root.style.opacity = '0'
    } else {
      root.style.opacity = savedOpacity
    }
  }

  log.info(`compositor ready — layers: ${[...layers].join(', ')}`)

  return {
    active: true,
    canvas,
    text,
    stats: () => ({
      active: true,
      boxes: scene.boxes.length,
      images: scene.images.length,
      glyphs: scene.glyphCount(),
      fallback: text?.fallbackCount ?? 0,
      ligatures: text?.ligatureCount ?? 0,
      uploads: renderer.lastUploads,
      batches: renderer.lastBatches,
      draws: renderer.lastDraws,
      groups: renderer.lastGroups,
      readElements: reader.readElements,
      partialReads: reader.partialReads,
      readMs,
      uploadMs: renderer.lastUploadMs,
      encodeMs: renderer.lastEncodeMs,
      fps
    }),
    start() {
      scheduler.start()
      sync.start()
      window.addEventListener('resize', onResize)
      window.addEventListener('scroll', onScroll, { passive: true })
      if (mode === 'replace' && hideSource) setSourceHidden(true)
    },
    stop() {
      scheduler.stop()
      sync.stop()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll)
      setSourceHidden(false)
    },
    setSourceHidden,
    invalidate() {
      pendingReadFlags = Dirty.ALL
      scheduler.request()
    },
    destroy() {
      scheduler.stop()
      sync.stop()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll)
      setSourceHidden(false)
      renderer.destroy()
      gpu.root.destroy()
      canvas.remove()
    }
  }
}

function inert(): Compositor & { text: null } {
  return {
    active: false,
    canvas: null,
    text: null,
    stats: () => ({
      active: false,
      boxes: 0,
      images: 0,
      glyphs: 0,
      fallback: 0,
      ligatures: 0,
      uploads: 0,
      batches: 0,
      draws: 0,
      groups: 0,
      readElements: 0,
      partialReads: 0,
      readMs: 0,
      uploadMs: 0,
      encodeMs: 0,
      fps: 0
    }),
    start() {},
    stop() {},
    invalidate() {},
    setSourceHidden() {},
    destroy() {}
  }
}
