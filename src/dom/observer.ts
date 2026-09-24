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

/** Could adding/removing this node change which stylesheets apply? */
function carriesStylesheet(n: Node): boolean {
  if (n.nodeType !== Node.ELEMENT_NODE) return false
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
 */
export class DomSync {
  private dirty: number = Dirty.ALL
  private scopes = new Set<Element>()
  private spare = new Set<Element>()
  private ro: ResizeObserver
  private mo: MutationObserver
  private io: IntersectionObserver
  private started = false

  constructor(
    private readonly root: HTMLElement,
    private readonly onInvalidate: () => void
  ) {
    this.ro = new ResizeObserver(() => this.mark(Dirty.LAYOUT))
    this.mo = new MutationObserver((records) => {
      let flag = Dirty.NONE
      for (const r of records) flag |= this.scope(r)
      this.mark(flag)
    })
    this.io = new IntersectionObserver(() => this.mark(Dirty.LAYOUT))
  }

  /** Record `r`'s scope; returns the flag it implies. */
  private scope(r: MutationRecord): number {
    const t = r.target
    if (r.type === 'attributes') {
      if (t === this.root) return Dirty.STYLE
      const p = t.parentElement
      // Detached: its removal is a childList record on the old parent.
      if (!p) return Dirty.NONE
      this.scopes.add(p)
      return Dirty.MUTATION
    }
    if (r.type === 'characterData') {
      const p = t.parentElement
      if (!p) return Dirty.NONE
      if (p.tagName === 'STYLE') return Dirty.CONTENT
      this.scopes.add(p)
      return Dirty.MUTATION
    }
    // childList
    const el = t as Element
    if (el.tagName === 'STYLE') return Dirty.CONTENT
    for (const n of r.addedNodes) if (carriesStylesheet(n)) return Dirty.CONTENT
    for (const n of r.removedNodes) {
      if (carriesStylesheet(n)) return Dirty.CONTENT
    }
    this.scopes.add(el)
    return Dirty.MUTATION
  }

  private mark(flag: number): void {
    if (flag === Dirty.NONE) return
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

  start(): void {
    if (this.started) return
    this.started = true
    this.ro.observe(this.root)
    this.mo.observe(this.root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['style', 'class']
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
    if (!this.started) return
    this.started = false
    this.ro.disconnect()
    this.mo.disconnect()
    this.io.disconnect()
    window.removeEventListener('scroll', this.onScroll)
    window.removeEventListener('resize', this.onResize)
    document.fonts?.removeEventListener('loadingdone', this.onFontsLoaded)
    this.root.removeEventListener('load', this.onLoad, true)
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
