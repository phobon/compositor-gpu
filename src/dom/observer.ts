/**
 * Kinds of invalidation a frame may need to service. LAYOUT, STYLE and
 * CONTENT each demand a full re-read; MUTATION means only the scopes
 * collected alongside it need re-reading (see SceneReader.partialRead).
 */
export enum Dirty {
  NONE = 0,
  SCROLL = 1,
  LAYOUT = 2,
  STYLE = 4,
  CONTENT = 8,
  ALL = 2 | 4 | 8,
  MUTATION = 16
}

export interface DirtyState {
  flags: number
  /** Elements whose subtree must be re-read; valid until the next take(). */
  scopes: ReadonlySet<Element>
}

const STYLESHEET = 'style, link[rel~="stylesheet"]'

const ANIM_START = ['transitionrun', 'transitionstart', 'animationstart']
const TRANSITION_END = ['transitionend', 'transitioncancel']
const ANIMATION_END = ['animationend', 'animationcancel']

/** Does `el` still have an unfinished (running or paused) CSS transition
 * or animation of the given kind? `getAnimations()` includes finished
 * animations that are still filling, so check playState. Without the Web
 * Animations API, assume nothing is left. */
function hasPending(el: Element, kind: 'transition' | 'animation'): boolean {
  if (typeof el.getAnimations !== 'function') {
    return false
  }
  for (const a of el.getAnimations()) {
    if (a.playState === 'finished' || a.playState === 'idle') {
      continue
    }
    const isTransition =
      typeof CSSTransition !== 'undefined' && a instanceof CSSTransition
    if (isTransition === (kind === 'transition')) {
      return true
    }
  }
  return false
}

/** Is any of `el`'s animations actually advancing (not paused)? True
 * without the Web Animations API, to stay on the safe side. */
function isAdvancing(el: Element): boolean {
  if (typeof el.getAnimations !== 'function') {
    return true
  }
  for (const a of el.getAnimations()) {
    if (a.playState === 'running') {
      return true
    }
  }
  return false
}

/** Properties (lowercased, hyphens removed) whose animation cannot change
 * layout; any `*color` property also qualifies. */
const PAINT_ONLY = new Set([
  'transform',
  'translate',
  'rotate',
  'scale',
  'opacity',
  'filter',
  'backdropfilter',
  'boxshadow',
  'textshadow',
  'visibility'
])
const KEYFRAME_META = new Set([
  'offset',
  'computedOffset',
  'easing',
  'composite'
])

function paintOnlyProperty(name: string): boolean {
  const n = name.replace(/-/g, '').toLowerCase()
  return PAINT_ONLY.has(n) || n.endsWith('color')
}

/** Can this animation only change paint (never layout)? False when it is
 * unknown (not a CSS transition/animation, or a `transition: all`). */
function animatesPaintOnly(a: Animation): boolean {
  if (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) {
    return paintOnlyProperty(a.transitionProperty)
  }
  if (typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation) {
    const effect = a.effect as KeyframeEffect | null
    if (!effect || typeof effect.getKeyframes !== 'function') {
      return false
    }
    for (const kf of effect.getKeyframes()) {
      for (const prop of Object.keys(kf)) {
        if (!KEYFRAME_META.has(prop) && !paintOnlyProperty(prop)) {
          return false
        }
      }
    }
    return true
  }
  return false
}

/** Are all of `el`'s unfinished animations paint-only? */
function paintOnlyAnimations(el: Element): boolean {
  if (typeof el.getAnimations !== 'function') {
    return false
  }
  for (const a of el.getAnimations()) {
    if (a.playState === 'finished' || a.playState === 'idle') {
      continue
    }
    if (!animatesPaintOnly(a)) {
      return false
    }
  }
  return true
}

/** Could adding/removing this node change which stylesheets apply? */
function carriesStylesheet(n: Node): boolean {
  if (n.nodeType !== Node.ELEMENT_NODE) {
    return false
  }
  const el = n as Element
  return el.matches(STYLESHEET) || el.querySelector(STYLESHEET) !== null
}

/**
 * Wires DOM observers to a single coalesced invalidation callback. Observers
 * never touch GPU state — they only set flags, collect scopes and request a
 * frame.
 *
 * Mutation records map to scopes (the element whose subtree is re-read):
 * childList → the target; characterData → the text node's parent element;
 * attributes on T → T's parent (T's margin box may change and move its
 * siblings; the parent's own style did not change). An <img> `load` scopes
 * to the image itself. Anything touching a stylesheet, an attribute on the
 * root, and every non-mutation source (resize, fonts, other loads) is a
 * full read.
 *
 * CSS transitions and animations change computed style without producing
 * mutation records. Their targets are tracked from the animation events
 * (captured on the root) in `animating`; while any run, the frame re-reads
 * `animatingScopes()` every frame.
 */
/** Elements carrying this attribute (and their subtrees) are neither
 * mirrored nor watched: debug overlays, the page's own stats readouts,
 * anything that would otherwise invalidate the mirror every frame. */
export const IGNORE_ATTR = 'data-gpu-ignore'

export const isIgnored = (n: Node): boolean => {
  const el = n instanceof Element ? n : n.parentElement
  return el !== null && el.closest(`[${IGNORE_ATTR}]`) !== null
}

/** Why the mirror was invalidated, cumulative since start(), plus the last
 * mutation's target — for `stats().sync`. */
export interface SyncDiagnostics {
  layout: number
  style: number
  content: number
  mutation: number
  /** Elements currently tracked as running a CSS transition/animation. */
  animating: number
  /** Tag/id/class of the last mutation record's target. */
  last: string
}

const describeEl = (n: Node): string => {
  const el = n instanceof Element ? n : n.parentElement
  if (!el) {
    return String(n.nodeName)
  }
  const cls = typeof el.className === 'string' ? el.className : ''
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${
    cls ? `.${cls.trim().split(/\s+/).slice(0, 2).join('.')}` : ''
  }`
}

export class DomSync {
  private dirty: number = Dirty.ALL
  readonly diag: SyncDiagnostics = {
    layout: 0,
    style: 0,
    content: 0,
    mutation: 0,
    animating: 0,
    last: ''
  }
  private scopes = new Set<Element>()
  private spare = new Set<Element>()
  private ro: ResizeObserver
  private mo: MutationObserver
  private io: IntersectionObserver
  private started = false
  private animating = new Set<Element>()
  /** Targets yielded as paint-only by the last animatingScopes() pass. */
  private paintOnlyLast = new Set<Element>()
  /** Paint-only targets that just settled: one final re-read of their own
   * subtree on the next animatingScopes() pass. */
  private settled = new Set<Element>()

  constructor(
    private readonly root: HTMLElement,
    private readonly onInvalidate: () => void
  ) {
    this.ro = new ResizeObserver(() => this.mark(Dirty.LAYOUT))
    this.mo = new MutationObserver((records) => {
      let flag = Dirty.NONE
      for (const r of records) {
        if (isIgnored(r.target)) {
          continue
        }
        const f = this.scope(r)
        if (f !== Dirty.NONE) {
          this.diag.last = `${r.type} ${describeEl(r.target)}${
            r.attributeName ? `[${r.attributeName}]` : ''
          }`
        }
        flag |= f
      }
      this.mark(flag)
    })
    this.io = new IntersectionObserver(() => this.mark(Dirty.LAYOUT))
  }

  /** Record `r`'s scope; returns the flag it implies. */
  private scope(r: MutationRecord): number {
    const t = r.target
    if (r.type === 'attributes') {
      if (t === this.root) {
        return Dirty.STYLE
      }
      const p = t.parentElement
      // Detached: its removal is a childList record on the old parent.
      if (!p) {
        return Dirty.NONE
      }
      this.scopes.add(p)
      return Dirty.MUTATION
    }
    if (r.type === 'characterData') {
      const p = t.parentElement
      if (!p) {
        return Dirty.NONE
      }
      if (p.tagName === 'STYLE') {
        return Dirty.CONTENT
      }
      this.scopes.add(p)
      return Dirty.MUTATION
    }
    // childList
    const el = t as Element
    if (el.tagName === 'STYLE') {
      return Dirty.CONTENT
    }
    for (const n of r.addedNodes) {
      if (carriesStylesheet(n)) {
        return Dirty.CONTENT
      }
    }
    for (const n of r.removedNodes) {
      if (carriesStylesheet(n)) {
        return Dirty.CONTENT
      }
    }
    this.scopes.add(el)
    return Dirty.MUTATION
  }

  private mark(flag: number): void {
    if (flag === Dirty.NONE) {
      return
    }
    const d = this.diag
    if (flag & Dirty.LAYOUT) {
      d.layout++
    }
    if (flag & Dirty.STYLE) {
      d.style++
    }
    if (flag & Dirty.CONTENT) {
      d.content++
    }
    if (flag & Dirty.MUTATION) {
      d.mutation++
    }
    this.dirty |= flag
    this.onInvalidate()
  }

  /** Scope a re-read to `el`'s subtree (e.g. a background-image finished
   * loading). Goes through the same partial-read path as a mutation; the
   * rect-change check in SceneReader.partialRead escalates to a full read
   * if needed. */
  invalidateScope(el: Element): void {
    this.scopes.add(el)
    this.mark(Dirty.MUTATION)
  }

  private onScroll = (): void => this.mark(Dirty.SCROLL)
  private onResize = (): void => this.mark(Dirty.LAYOUT)
  private onFontsLoaded = (): void => this.mark(Dirty.CONTENT)

  private onLoad = (e: Event): void => {
    const t = e.target
    if (t instanceof HTMLImageElement) {
      this.scopes.add(t)
      this.mark(Dirty.MUTATION)
    } else {
      this.mark(Dirty.CONTENT)
    }
  }

  private onAnimStart = (e: Event): void => {
    const t = e.target
    if (!(t instanceof Element) || isIgnored(t)) {
      return
    }
    const had = this.animating.size
    this.animating.add(t)
    if (had === 0) {
      this.mark(Dirty.MUTATION)
    }
  }

  private onTransitionEnd = (e: Event): void => {
    const t = e.target
    if (!(t instanceof Element) || !this.animating.has(t)) {
      return
    }
    // Another transition on the same element may still be running.
    if (hasPending(t, 'transition')) {
      return
    }
    this.settle(t)
  }

  private onAnimationEnd = (e: Event): void => {
    const t = e.target
    if (!(t instanceof Element) || !this.animating.has(t)) {
      return
    }
    // An element can run several animations; keep it until all are done.
    if (hasPending(t, 'animation')) {
      return
    }
    this.settle(t)
  }

  /** Stop tracking `t`, with one final re-read of its end state. */
  private settle(t: Element): void {
    this.animating.delete(t)
    if (this.paintOnlyLast.delete(t)) {
      this.settled.add(t)
      this.mark(Dirty.MUTATION)
      return
    }
    const p = t.parentElement
    if (p) {
      this.scopes.add(p)
    }
    this.mark(p ? Dirty.MUTATION : Dirty.STYLE)
  }

  /**
   * Re-read scopes for running transitions/animations. A target whose
   * animations can only change paint (transform, opacity, filter, colours
   * — see PAINT_ONLY) is its own scope and is added to `paintOnly`: its
   * margin box can't move, so SceneReader.partialRead may skip the
   * rect-change check for it. Otherwise the scope is the target's parent
   * (the attribute-scope rule — the target's own margin box may change),
   * or the target itself at the root. Targets whose animations are all
   * paused stay tracked but yield nothing (a paused animation's resumption
   * is a style/class mutation, which requests a frame).
   */
  *animatingScopes(paintOnly?: Set<Element>): Iterable<Element> {
    for (const el of this.settled) {
      if (!el.isConnected) {
        continue
      }
      paintOnly?.add(el)
      yield el
    }
    this.settled.clear()
    this.paintOnlyLast.clear()
    this.diag.animating = this.animating.size
    for (const el of this.animating) {
      if (!el.isConnected) {
        this.animating.delete(el)
        continue
      }
      if (!isAdvancing(el)) {
        continue
      }
      if (el !== this.root && paintOnlyAnimations(el)) {
        this.paintOnlyLast.add(el)
        paintOnly?.add(el)
        yield el
      } else {
        yield el.parentElement ?? el
      }
    }
  }

  start(): void {
    if (this.started) {
      return
    }
    this.started = true
    // Nothing was observed while stopped: the tree may be stale.
    this.dirty = Dirty.ALL
    for (const type of ANIM_START) {
      this.root.addEventListener(type, this.onAnimStart, true)
    }
    for (const type of TRANSITION_END) {
      this.root.addEventListener(type, this.onTransitionEnd, true)
    }
    for (const type of ANIMATION_END) {
      this.root.addEventListener(type, this.onAnimationEnd, true)
    }
    // Transitions/animations already running (started before start(), so
    // their start events were missed).
    if (typeof this.root.getAnimations === 'function') {
      for (const a of this.root.getAnimations({ subtree: true })) {
        const t = (a.effect as KeyframeEffect | null)?.target
        if (t) {
          this.animating.add(t)
        }
      }
    }
    this.ro.observe(this.root)
    this.mo.observe(this.root, {
      subtree: true,
      childList: true,
      characterData: true,
      // Any attribute can drive CSS (`data-*`, `aria-*`, `hidden`, `open`).
      attributes: true
    })
    window.addEventListener('scroll', this.onScroll, { passive: true })
    window.addEventListener('resize', this.onResize, { passive: true })
    // <img> load doesn't bubble; capture it to mirror images once decoded.
    this.root.addEventListener('load', this.onLoad, true)
    document.fonts?.ready.then(() => this.mark(Dirty.CONTENT))
    // Each later font load reflows text and invalidates atlas glyphs drawn
    // with a fallback face: full re-read.
    document.fonts?.addEventListener('loadingdone', this.onFontsLoaded)
  }

  stop(): void {
    if (!this.started) {
      return
    }
    this.started = false
    this.ro.disconnect()
    this.mo.disconnect()
    this.io.disconnect()
    window.removeEventListener('scroll', this.onScroll)
    window.removeEventListener('resize', this.onResize)
    document.fonts?.removeEventListener('loadingdone', this.onFontsLoaded)
    this.root.removeEventListener('load', this.onLoad, true)
    for (const type of ANIM_START) {
      this.root.removeEventListener(type, this.onAnimStart, true)
    }
    for (const type of TRANSITION_END) {
      this.root.removeEventListener(type, this.onTransitionEnd, true)
    }
    for (const type of ANIMATION_END) {
      this.root.removeEventListener(type, this.onAnimationEnd, true)
    }
    this.animating.clear()
    this.paintOnlyLast.clear()
    this.settled.clear()
  }

  /** Read + clear the pending dirty flags and scopes for this frame. */
  take(): DirtyState {
    const flags = this.dirty
    const scopes = this.scopes
    this.dirty = Dirty.NONE
    this.scopes = this.spare
    this.scopes.clear()
    this.spare = scopes
    return { flags, scopes }
  }
}
