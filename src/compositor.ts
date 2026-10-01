import { BoxPass } from './boxes/boxRenderer'
import { CutoutPass } from './boxes/cutoutPass'
import { Dirty, DomSync, HIDDEN_ATTR, IGNORE_ATTR } from './dom/observer'
import { textReadStats } from './dom/textRuns'
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

/** Frames keep running on rAF this long after the last `scroll` event. */
export const SCROLL_SETTLE_MS = 150

/**
 * Create a compositor that mirrors `root` onto a GPU canvas overlay. Async
 * because WebGPU device init is async. Never throws in 'passthrough' fallback:
 * if WebGPU is unavailable you get an inert compositor and the untouched page.
 */
export async function createCompositor(
  options: CompositorOptions = {}
): Promise<Compositor & { text: SlugText | null; scene: Scene | null }> {
  const root = options.root ?? document.body
  const layers = new Set<Layer>(options.layers ?? ['boxes', 'images', 'text'])
  // Holes for data-gpu-ignore elements go with any painted layer.
  if (layers.size > 0) {
    layers.add('cutouts')
  }
  const fallback = options.fallback ?? 'passthrough'
  const mode = options.mode ?? 'overlay'
  const hideSource = options.hideSource ?? true
  setDebug(Boolean(options.debug))

  const canvas = document.createElement('canvas')
  // `position: absolute`, not fixed: the canvas is part of the root
  // scroller's content, so the browser's compositor thread scrolls it in
  // lockstep with the page (no frame of lag). It
  // covers the viewport plus `canvasMargin` above and below, and frame()
  // moves it (the anchor) when the viewport scrolls out of it.
  Object.assign(canvas.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    pointerEvents: 'none',
    zIndex: String(options.zIndex ?? 2147483646)
  } satisfies Partial<CSSStyleDeclaration>)
  canvas.setAttribute('aria-hidden', 'true')
  // Mount on <html>, not <body>: replace mode hides the mirrored root's
  // paint via opacity, and the canvas must never be a descendant of it.
  document.documentElement.appendChild(canvas)

  const gpu = await initGpu(canvas)
  if (!gpu) {
    canvas.remove()
    if (fallback === 'throw') {
      throw new Error('[compositor-gpu] WebGPU unavailable')
    }
    return inert()
  }

  const dpr = options.devicePixelRatio ?? window.devicePixelRatio ?? 1
  gpu.device.pushErrorScope('validation')
  const renderer = new Renderer(gpu)
  if (layers.has('boxes')) {
    renderer.addPass(new BoxPass(renderer.shared))
  }
  if (layers.has('images')) {
    // `scene`/`scheduler` are declared further down this function; this
    // closes over those bindings lazily — `onReady` only fires once a
    // `createImageBitmap()` resolves, well after both exist (see the
    // `sync`/`reader` comment below for the same pattern).
    renderer.addPass(
      new ImagePass(renderer.shared, () => {
        scene.markDirty('images')
        scheduler.request()
      })
    )
  }
  let text: SlugText | null = null
  if (layers.has('text')) {
    text = new SlugText(renderer.shared)
    renderer.addPass(text)
  }
  if (layers.has('cutouts')) {
    renderer.addPass(new CutoutPass(renderer.shared))
  }
  gpu.device.popErrorScope().then((e) => {
    if (e) {
      log.error('GPU validation error during setup:', e.message)
    }
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
  let frameMs = 0
  let maxDtMs = 0
  let maxDtWindow = 0
  let maxDtAt = 0
  let readMs = 0
  const paintOnly = new Set<Element>()
  let lastScrollAt = -Infinity
  let lastScrollX = window.scrollX
  let lastScrollY = window.scrollY

  // The viewport minus any classic scrollbar (innerWidth/Height include
  // it, which would squeeze the mirror horizontally).
  const viewW = (): number => document.documentElement.clientWidth
  const viewH = (): number => document.documentElement.clientHeight
  // The canvas region in document space (CSS px): origin (the anchor) and
  // size. It covers the viewport plus `margin` above and below, clamped to
  // the document's scrollable size so it never grows the page.
  let anchorX = 0
  let anchorY = 0
  let canvasW = 0
  let canvasH = 0
  let reanchors = 0
  const maxDim = gpu.device.limits.maxTextureDimension2D
  // The document's scrollable size without the canvas: once content
  // shrinks, a canvas at the old bottom/right edge would hold scrollHeight
  // up. Forces layout; call only when re-anchoring.
  const docSize = (vw: number, vh: number): [number, number] => {
    const de = document.documentElement
    let w = de.scrollWidth
    let h = de.scrollHeight
    const right = anchorX + canvasW
    const bottom = anchorY + canvasH
    if ((h <= bottom && bottom > vh) || (w <= right && right > vw)) {
      canvas.style.display = 'none'
      w = de.scrollWidth
      h = de.scrollHeight
      canvas.style.display = ''
    }
    return [w, h]
  }
  // Re-anchor when the visible viewport is not inside the canvas (or on
  // `force`: a resize). Vertically the new canvas starts `margin` above the
  // viewport; horizontally there is no slack, so any horizontal scroll
  // re-anchors.
  const place = (
    scrollX: number,
    scrollY: number,
    vw: number,
    vh: number,
    force: boolean
  ): void => {
    if (
      !force &&
      scrollX >= anchorX &&
      scrollX + vw <= anchorX + canvasW &&
      scrollY >= anchorY &&
      scrollY + vh <= anchorY + canvasH
    ) {
      return
    }
    const margin = Math.max(0, Math.round(options.canvasMargin ?? vh))
    const [docW, docH] = docSize(vw, vh)
    // The swapchain texture is capped at maxTextureDimension2D (8192 on
    // most adapters): a tall viewport at a high dpr shrinks the margin.
    const w = vw
    const h = Math.min(
      vh + 2 * margin,
      Math.max(docH, vh),
      Math.max(vh, Math.floor(maxDim / dpr))
    )
    anchorX = Math.min(Math.max(scrollX, 0), Math.max(docW - w, 0))
    anchorY = Math.min(Math.max(scrollY - margin, 0), Math.max(docH - h, 0))
    reanchors++
    const s = canvas.style
    s.left = `${anchorX}px`
    s.top = `${anchorY}px`
    if (w !== canvasW || h !== canvasH) {
      canvasW = w
      canvasH = h
      s.width = `${w}px`
      s.height = `${h}px`
      canvas.width = Math.min(Math.floor(w * dpr), maxDim)
      canvas.height = Math.min(Math.floor(h * dpr), maxDim)
    }
  }
  place(window.scrollX, window.scrollY, viewW(), viewH(), true)

  const isScrolling = (): boolean =>
    performance.now() - lastScrollAt < SCROLL_SETTLE_MS

  const frame = (time: number, dt: number): void => {
    const t0 = performance.now()
    // Longest gap between frames over the last second: a hitch detector.
    if (time - maxDtAt >= 1000) {
      maxDtMs = maxDtWindow
      maxDtWindow = 0
      maxDtAt = time
    }
    maxDtWindow = Math.max(maxDtWindow, dt * 1000)
    const dirty = sync.take()
    let flags = dirty.flags | pendingReadFlags
    pendingReadFlags = Dirty.NONE
    // Running CSS transitions/animations fire no mutation records: re-read
    // their scopes every frame while any run (dirty.scopes is ours until
    // the next take()).
    let cssAnimating = false
    const scopes = dirty.scopes as Set<Element>
    // Paint-only animation scopes skip the partial read's rect check, but
    // only when no mutation shares the frame (it could move them).
    paintOnly.clear()
    const mutated = scopes.size > 0
    for (const el of sync.animatingScopes(paintOnly)) {
      scopes.add(el)
      cssAnimating = true
    }
    // A sticky element's offset is a paint-time shift that depends on
    // scroll: re-read each one that moved (paint-only — layout doesn't
    // change) once per frame that scrolled.
    const scrollX = window.scrollX
    const scrollY = window.scrollY
    if (scrollX !== lastScrollX || scrollY !== lastScrollY) {
      lastScrollX = scrollX
      lastScrollY = scrollY
      for (const el of reader.movedStickies()) {
        scopes.add(el)
        paintOnly.add(el)
        flags |= Dirty.MUTATION
      }
    }
    if (mutated) {
      paintOnly.clear()
    }
    if (cssAnimating) {
      flags |= Dirty.MUTATION
    }

    if (flags & (Dirty.LAYOUT | Dirty.STYLE | Dirty.CONTENT)) {
      const t0 = performance.now()
      reader.fullRead()
      readMs = performance.now() - t0
    } else if (flags & Dirty.MUTATION) {
      const t0 = performance.now()
      reader.partialRead(dirty.scopes, paintOnly)
      readMs = performance.now() - t0
    }
    // After the reads (layout is clean, so docSize() costs no extra
    // reflow when it doesn't toggle the canvas), and in the same task as
    // render(), so the new position and the new pixels land in one paint.
    // The viewport size is read first: after place() moves the canvas,
    // reading it would force another layout.
    const width = viewW()
    const height = viewH()
    place(scrollX, scrollY, width, height, (flags & Dirty.LAYOUT) !== 0)

    const ctx: FrameContext = {
      time,
      dt,
      scrollX,
      scrollY,
      width,
      height,
      canvasX: anchorX,
      canvasY: anchorY,
      canvasWidth: canvasW,
      canvasHeight: canvasH
    }

    if (options.onGlyph) {
      for (const run of scene.runs) {
        for (const g of run.glyphs) {
          options.onGlyph(g, ctx)
        }
      }
      // Only glyph offsets changed: re-upload just the text layer.
      scene.markDirty('text')
    }
    // A live <video>/<canvas> changes without a DOM mutation: re-upload just the
    // image layer (which re-copies its texture) and keep the loop running.
    if (scene.hasDynamic) {
      scene.markDirty('images')
    }
    options.onFrame?.(ctx)

    // The swapchain texture can't be created at 0x0 (e.g. before the canvas
    // has laid out, when innerWidth is briefly 0). Skip the frame; a resize
    // re-requests one once the viewport has a size.
    if (canvas.width === 0 || canvas.height === 0) {
      if (animating || scene.hasDynamic || cssAnimating || isScrolling()) {
        scheduler.request()
      }
      return
    }

    if (dt > 0) {
      fps = fps ? fps * 0.9 + 0.1 / dt : 1 / dt
    }
    renderer.render(scene, ctx, dpr)
    frameMs = performance.now() - t0
    if (animating || scene.hasDynamic || cssAnimating || isScrolling()) {
      scheduler.request()
    }
  }

  const scheduler = new FrameScheduler(frame)
  const sync = new DomSync(root, () => scheduler.request())

  if (text) {
    // 'auto' (the default) discovers the document's registered faces; an
    // explicit list resolves just those. Either way the bytes are fetched
    // at runtime, then a re-read re-uploads the glyphs.
    const fonts = options.fonts ?? 'auto'
    const faces = fonts === 'auto' ? Array.from(document.fonts) : fonts
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
  // Positions are absolute document space (or viewport space for fixed
  // subtrees), so scrolling only needs a re-render (updated frame.scroll),
  // not a re-read — except sticky elements, re-read in frame() when the
  // scroll position changed since the last frame. The canvas is absolute,
  // so the browser's compositor thread scrolls it with the page and
  // doc-space content never trails the DOM; frame() only has to re-anchor
  // it before the viewport leaves it. Viewport-space (fixed) content is
  // drawn at its position at frame time and moves with the page until the
  // next frame, as do sticky offsets. `scroll` events can arrive at half
  // the rAF rate (60 Hz events on a 120 Hz display), so the event stamps
  // the time and frame() keeps requesting rAF ticks until SCROLL_SETTLE_MS
  // after the last event, rendering each with the current
  // window.scrollX/Y.
  const onScroll = (): void => {
    lastScrollAt = performance.now()
    scheduler.request()
  }

  // Replace mode: hide the mirrored root's own paint while keeping its layout,
  // focus, selection, hit-testing and a11y tree intact (opacity leaves all of
  // those untouched). Reversible; the GPU canvas provides the pixels.
  // Subtrees marked `data-gpu-ignore` aren't mirrored, so they must keep
  // their own paint: opacity goes on the outermost elements that contain no
  // ignored element instead of on the root. An ancestor of an ignored
  // element therefore keeps painting its own background/borders (its text
  // and other children are still hidden) — keep ignored elements under
  // paint-free wrappers.
  let sourceHidden = false
  const hiddenEls = new Map<HTMLElement, string>()
  // The reader must not see the hiding opacity (it would make every
  // hidden element an opacity-0 group and skip it): HIDDEN_ATTR carries
  // the computed opacity from before, which readOpacity() prefers.
  const hide = (el: HTMLElement): void => {
    hiddenEls.set(el, el.style.opacity)
    el.setAttribute(HIDDEN_ATTR, getComputedStyle(el).opacity)
    el.style.opacity = '0'
  }
  const hideUnder = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      if (!(child instanceof HTMLElement) || child.hasAttribute(IGNORE_ATTR)) {
        continue
      }
      if (child.querySelector(`[${IGNORE_ATTR}]`)) {
        hideUnder(child)
      } else {
        hide(child)
      }
    }
  }
  const setSourceHidden = (hidden: boolean): void => {
    if (hidden === sourceHidden || !(root instanceof HTMLElement)) {
      return
    }
    sourceHidden = hidden
    if (hidden) {
      if (root.querySelector(`[${IGNORE_ATTR}]`)) {
        hideUnder(root)
      } else {
        hide(root)
      }
    } else {
      for (const [el, saved] of hiddenEls) {
        el.style.opacity = saved
        el.removeAttribute(HIDDEN_ATTR)
      }
      hiddenEls.clear()
    }
  }

  let destroyed = false
  let lost = false
  const stop = (): void => {
    scheduler.stop()
    sync.stop()
    window.removeEventListener('resize', onResize)
    window.removeEventListener('scroll', onScroll)
    setSourceHidden(false)
  }
  // A lost device can't render again: give the page its own paint back.
  void gpu.device.lost.then((info) => {
    if (destroyed) {
      return
    }
    log.error(`GPU device lost (${info.reason}): ${info.message}`)
    lost = true
    stop()
  })

  log.info(`compositor ready — layers: ${[...layers].join(', ')}`)

  return {
    active: true,
    canvas,
    text,
    scene,
    stats: () => ({
      active: true,
      boxes: scene.boxes.length,
      images: scene.images.length,
      glyphs: scene.glyphCount(),
      cutouts: scene.cutouts.length,
      fallback: text?.fallbackCount ?? 0,
      fallbackSamples: text ? Array.from(text.fallbackSamples) : [],
      ligatures: text?.ligatureCount ?? 0,
      faces: text?.faceCount ?? 0,
      uploads: renderer.lastUploads,
      batches: renderer.lastBatches,
      draws: renderer.lastDraws,
      groups: renderer.lastGroups,
      readElements: reader.readElements,
      partialReads: reader.partialReads,
      sync: { ...sync.diag },
      textRead: { ...textReadStats },
      readMs,
      uploadMs: renderer.lastUploadMs,
      encodeMs: renderer.lastEncodeMs,
      fps,
      frameMs,
      maxDtMs,
      scrolling: isScrolling(),
      anchorX,
      anchorY,
      reanchors
    }),
    start() {
      if (destroyed || lost) {
        return
      }
      scheduler.start()
      sync.start()
      window.addEventListener('resize', onResize)
      window.addEventListener('scroll', onScroll, { passive: true })
      if (mode === 'replace' && hideSource) {
        setSourceHidden(true)
      }
    },
    stop,
    setSourceHidden,
    invalidate() {
      if (destroyed || lost) {
        return
      }
      pendingReadFlags = Dirty.ALL
      scheduler.request()
    },
    destroy() {
      if (destroyed) {
        return
      }
      destroyed = true
      stop()
      reader.destroy()
      renderer.destroy()
      gpu.root.destroy()
      canvas.remove()
    }
  }
}

function inert(): Compositor & { text: null; scene: null } {
  return {
    active: false,
    canvas: null,
    text: null,
    scene: null,
    stats: () => ({
      active: false,
      boxes: 0,
      images: 0,
      glyphs: 0,
      cutouts: 0,
      fallback: 0,
      fallbackSamples: [],
      ligatures: 0,
      faces: 0,
      uploads: 0,
      batches: 0,
      draws: 0,
      groups: 0,
      readElements: 0,
      partialReads: 0,
      sync: {
        layout: 0,
        style: 0,
        content: 0,
        mutation: 0,
        animating: 0,
        last: ''
      },
      textRead: { graphemes: 0, perGrapheme: 0, ranges: 0 },
      readMs: 0,
      uploadMs: 0,
      encodeMs: 0,
      fps: 0,
      frameMs: 0,
      maxDtMs: 0,
      scrolling: false,
      anchorX: 0,
      anchorY: 0,
      reanchors: 0
    }),
    start() {},
    stop() {},
    invalidate() {},
    setSourceHidden() {},
    destroy() {}
  }
}
