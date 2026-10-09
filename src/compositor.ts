import { BoxPass } from './boxes/boxRenderer'
import { CutoutPass } from './boxes/cutoutPass'
import { Dirty, DomSync, HIDDEN_ATTR, IGNORE_ATTR } from './dom/observer'
import { textReadStats } from './dom/textRuns'
import type { ElNode } from './dom/tree'
import { SceneReader, subtreeZ } from './dom/tree'
import { initGpu } from './gpu/device'
import type {
  FrameHook,
  LayerPlace,
  MaterialEntry,
  RenderGraph
} from './gpu/graph'
import { materialPipelinesPending } from './gpu/material'
import { Renderer } from './gpu/renderer'
import { ImagePass } from './images/imageRenderer'
import type { Anchor } from './scene/batches'
import type { GlyphRun } from './scene/records'
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
  // Holes for data-gpu-ignore elements go with any painted layer, unless
  // opted out.
  if (layers.size > 0 && options.cutouts !== false) {
    layers.add('cutouts')
  } else if (options.cutouts === false) {
    layers.delete('cutouts')
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
  renderer.shared.dpr = dpr
  if (layers.has('boxes')) {
    renderer.addPass(new BoxPass(renderer.shared))
  }
  let imagePass: ImagePass | null = null
  if (layers.has('images')) {
    // `scene`/`scheduler` are declared further down this function; this
    // closes over those bindings lazily — `onReady` only fires once a
    // `createImageBitmap()` resolves, well after both exist (see the
    // `sync`/`reader` comment below for the same pattern).
    imagePass = new ImagePass(renderer.shared, () => {
      scene.markDirty('images')
      scheduler.request()
    })
    renderer.addPass(imagePass)
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
  reader.canvasZ = options.zIndex ?? 2147483646
  let pendingReadFlags = Dirty.ALL
  /** Elements whose isolation changed (a region pass or layer transform
   * started or ended): re-read as partial-read scopes on the next frame. */
  const isolationScopes = new Set<Element>()
  const animating = Boolean(options.onGlyph || options.onFrame)
  /** Render times in the last second (stats().fps counts them). */
  const frameTimes: number[] = []
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
    if (isolationScopes.size > 0) {
      for (const el of isolationScopes) {
        scopes.add(el)
      }
      isolationScopes.clear()
      flags |= Dirty.MUTATION
    }
    // Paint-only animation scopes skip the partial read's rect check,
    // except when a mutation in the same frame lies inside one (it could
    // change its layout size). A mutation outside one is covered by its
    // own boundary's rect check: if that boundary didn't move, neither did
    // anything outside it.
    paintOnly.clear()
    const mutated = scopes.size > 0
    const mutationScopes = mutated ? [...scopes] : null
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
    if (mutationScopes) {
      for (const el of paintOnly) {
        if (mutationScopes.some((m) => el.contains(m))) {
          paintOnly.delete(el)
        }
      }
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
      canvasHeight: canvasH,
      pointer: null
    }
    for (const h of hooks) {
      h.beforeFrame?.(ctx)
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
      if (
        animating ||
        scene.hasDynamic ||
        cssAnimating ||
        isScrolling() ||
        hooksAlive()
      ) {
        scheduler.request()
      }
      return
    }

    frameTimes.push(time)
    while ((frameTimes[0] ?? time) <= time - 1000) {
      frameTimes.shift()
    }
    renderer.render(scene, ctx, dpr)
    frameMs = performance.now() - t0
    if (
      animating ||
      scene.hasDynamic ||
      cssAnimating ||
      isScrolling() ||
      hooksAlive()
    ) {
      scheduler.request()
    }
  }

  const scheduler = new FrameScheduler(frame)
  // The effects layer's hooks (gpu/graph.ts).
  const hooks = new Set<FrameHook>()
  const hooksAlive = (): boolean => {
    for (const h of hooks) {
      if (h.keepAlive?.()) {
        return true
      }
    }
    return false
  }
  const graph: RenderGraph = {
    shared: renderer.shared,
    setPostChain(chain) {
      renderer.postChain = chain
      scheduler.request()
    },
    addHook(hook) {
      hooks.add(hook)
      return () => {
        hooks.delete(hook)
      }
    },
    requestFrame: () => scheduler.request(),
    addLayer(layer) {
      const id = nextExtra++
      renderer.extras.set(id, layer)
      rebatch()
      return () => {
        if (renderer.extras.delete(id)) {
          rebatch()
        }
      }
    },
    replace: () => rebatch(),
    isolate(el, handler) {
      const id = regionIds.get(el)
      if (!handler && (id === undefined || !renderer.regions.has(id))) {
        return
      }
      const rid = isolationId(el)
      if (handler) {
        renderer.regions.set(rid, handler)
      } else {
        renderer.regions.delete(rid)
      }
      updateIsolation(el, rid)
    },
    transform(el, t) {
      const id = regionIds.get(el)
      if (!t && (id === undefined || !renderer.transforms.has(id))) {
        return
      }
      const rid = isolationId(el)
      if (t) {
        renderer.transforms.set(rid, t)
      } else {
        renderer.transforms.delete(rid)
      }
      updateIsolation(el, rid)
    },
    addMaterial(entry) {
      renderer.materials.set(entry.id, entry)
      rebatch()
      return () => {
        if (renderer.materials.get(entry.id) === entry) {
          renderer.dropMaterial(entry.id)
          rebatch()
        }
      }
    },
    nextMaterialId: () => nextMaterial++,
    materialsPending: () => materialPipelinesPending(),
    hideSource(el, hidden) {
      if (!(el instanceof HTMLElement) || destroyed || lost) {
        return
      }
      if (hidden) {
        fxWanted.add(el)
        if (!stopped) {
          applyFx(el)
        }
      } else {
        fxWanted.delete(el)
        releaseFx(el)
      }
    },
    nodeOf: (el) => reader.nodeOf(el),
    imageOf(el) {
      const own = reader.nodeOf(el)?.own
      const rec = own?.find((r) => r.kind === 'image')
      return rec && imagePass ? imagePass.regionOf(rec) : null
    },
    glyphTable: () => text?.glyphTable() ?? null,
    get version() {
      return scene.version
    }
  }
  // Extra layers: ids into renderer.extras, placed in paint order by the
  // anchors resolved each time batches are built (after every read, and
  // on addLayer/replace).
  let nextExtra = 1
  let nextMaterial = 1
  let nextRegion = 1
  const regionIds = new Map<Element, number>()
  // An element is isolated (one group) while it has a region handler or a
  // layer transform; both share its id.
  const isolationId = (el: Element): number => {
    let id = regionIds.get(el)
    if (id === undefined) {
      id = nextRegion++
      regionIds.set(el, id)
    }
    return id
  }
  const updateIsolation = (el: Element, id: number): void => {
    const want = renderer.regions.has(id) || renderer.transforms.has(id)
    if (want === reader.isolated.has(el)) {
      scheduler.request()
      return
    }
    if (want) {
      reader.isolated.set(el, id)
    } else {
      reader.isolated.delete(el)
      regionIds.delete(el)
    }
    // Only the element's own node changes (it becomes, or stops being, a
    // stacking context): a partial read of it, then the scene re-flattens.
    // A partial read escalates to a full one if anything moved.
    isolationScopes.add(el)
    scheduler.request()
  }
  const rebatch = (): void => {
    scene.sort()
    scheduler.request()
  }
  // 'below' sits over the page background: after the own records (the
  // background boxes) of the mirrored root and of <html>/<body>.
  const belowZ = (): number => {
    let z = -1
    for (const el of [root, document.documentElement, document.body]) {
      const node = el ? reader.nodeOf(el) : undefined
      for (const r of node?.own ?? []) {
        z = Math.max(z, r.z)
      }
    }
    return z + 1
  }
  const anchorOf = (id: number, place: LayerPlace): Anchor | null => {
    if (place === 'above') {
      return { id, z: Number.POSITIVE_INFINITY, depth: 0 }
    }
    if (place === 'below') {
      return { id, z: belowZ(), depth: 0 }
    }
    const node = reader.nodeOf(place.after)
    const range = node ? subtreeZ(node) : null
    if (!node || !range) {
      return null
    }
    // Opacity groups enclosing the element (contexts with alpha < 1 or
    // isolated for a region), as assignPaintOrder nests them.
    let depth = 0
    for (let p = node.parent; p; p = p.parent) {
      if (p.isContext && (p.alpha < 1 || p.region !== undefined)) {
        depth++
      }
    }
    return { id, z: range[1] + 1, depth }
  }
  // Materials: tag the records of each active material's target subtree
  // (registration order, so a later material wins on overlap). Tags from
  // the previous build are cleared first; records rebuilt by a read have
  // none.
  let tagged: { material?: number }[] = []
  /** Glyph runs' bases from this build (a later material overwrites an
   * earlier one's, as it wins the run). */
  const bases = new Map<GlyphRun, number>()
  const tagSubtree = (
    node: ElNode,
    m: MaterialEntry,
    glyphs: { n: number }
  ): void => {
    const tag = (r: { material?: number }): void => {
      r.material = m.id
      tagged.push(r)
    }
    for (const r of node.own) {
      if (
        (r.kind === 'box' && m.kinds.has('box')) ||
        (r.kind === 'image' && m.kinds.has('image'))
      ) {
        tag(r)
      }
    }
    for (const kid of node.kids) {
      if (kid.kind === 'element') {
        tagSubtree(kid, m, glyphs)
      } else if (kid.kind === 'box') {
        if (m.kinds.has('box')) {
          tag(kid)
        }
      } else {
        if (m.kinds.has('glyph')) {
          tag(kid)
          bases.set(kid, glyphs.n)
          glyphs.n += kid.glyphs.length
        }
        if (m.kinds.has('box')) {
          for (const d of kid.decorations ?? []) {
            tag(d)
          }
          for (const d of kid.decorationsOver ?? []) {
            tag(d)
          }
        }
      }
    }
  }
  scene.assign = () => {
    for (const r of tagged) {
      delete r.material
    }
    tagged = []
    for (const m of renderer.materials.values()) {
      const node = m.active() ? reader.nodeOf(m.target) : undefined
      if (node) {
        const glyphs = { n: 0 }
        tagSubtree(node, m, glyphs)
        m.glyphs = glyphs.n
      }
    }
    // A moved base re-uploads the text (mat_index reads gref.z).
    let moved = false
    for (const [run, base] of bases) {
      if (run.glyphBase !== base) {
        run.glyphBase = base
        moved = true
      }
    }
    bases.clear()
    if (moved) {
      scene.markDirty('text')
    }
  }
  scene.anchors = () => {
    const out: Anchor[] = []
    for (const [id, layer] of renderer.extras) {
      const a = anchorOf(id, layer.place)
      if (a) {
        out.push(a)
      }
    }
    return out
  }
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
  // graph.hideSource (displacing materials): the elements materials want
  // hidden, and those this code hid (with the inline opacity to restore).
  // An element replace mode already hides stays in hiddenEls; turning
  // replace mode off hands it to fxHidden while a material still wants it.
  const fxWanted = new Set<HTMLElement>()
  const fxHidden = new Map<HTMLElement, string>()
  let stopped = false
  const applyFx = (el: HTMLElement): void => {
    if (fxHidden.has(el) || hiddenEls.has(el)) {
      return
    }
    fxHidden.set(el, el.style.opacity)
    el.setAttribute(HIDDEN_ATTR, getComputedStyle(el).opacity)
    el.style.opacity = '0'
  }
  const releaseFx = (el: HTMLElement): void => {
    const saved = fxHidden.get(el)
    if (saved === undefined) {
      return
    }
    fxHidden.delete(el)
    el.style.opacity = saved
    el.removeAttribute(HIDDEN_ATTR)
  }
  // The reader must not see the hiding opacity (it would make every
  // hidden element an opacity-0 group and skip it): HIDDEN_ATTR carries
  // the computed opacity from before, which readOpacity() prefers.
  const hide = (el: HTMLElement): void => {
    // Already hidden by a material: take it over (its HIDDEN_ATTR holds the
    // real opacity), restoring the pre-material inline value later.
    const fx = fxHidden.get(el)
    if (fx !== undefined) {
      fxHidden.delete(el)
      hiddenEls.set(el, fx)
      return
    }
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
        if (fxWanted.has(el)) {
          fxHidden.set(el, saved)
          continue
        }
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
    stopped = true
    for (const el of [...fxHidden.keys()]) {
      releaseFx(el)
    }
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
    graph,
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
      // Frames rendered in the last second (0 while idle).
      fps: frameTimes.filter((t) => t > performance.now() - 1000).length,
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
      stopped = false
      for (const el of fxWanted) {
        applyFx(el)
      }
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
    graph: null,
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
