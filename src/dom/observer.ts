/** Kinds of invalidation a frame may need to service. */
export enum Dirty {
  NONE = 0,
  SCROLL = 1,
  LAYOUT = 2,
  STYLE = 4,
  CONTENT = 8,
  ALL = 2 | 4 | 8
}

/**
 * Wires DOM observers to a single coalesced invalidation callback. Observers
 * never touch GPU state — they only set flags and request a frame.
 */
export class DomSync {
  private dirty: number = Dirty.ALL
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
      for (const r of records) {
        if (r.type === 'characterData' || r.type === 'childList') {
          flag |= Dirty.CONTENT
        } else if (r.type === 'attributes') {
          flag |= Dirty.STYLE
        }
      }
      this.mark(flag)
    })
    this.io = new IntersectionObserver(() => this.mark(Dirty.LAYOUT))
  }

  private mark(flag: number): void {
    if (flag === Dirty.NONE) return
    this.dirty |= flag
    this.onInvalidate()
  }

  private onScroll = (): void => this.mark(Dirty.SCROLL)
  private onResize = (): void => this.mark(Dirty.LAYOUT)

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
    document.fonts?.ready.then(() => this.mark(Dirty.CONTENT))
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.ro.disconnect()
    this.mo.disconnect()
    this.io.disconnect()
    window.removeEventListener('scroll', this.onScroll)
    window.removeEventListener('resize', this.onResize)
  }

  /** Read + clear the pending dirty flags for this frame. */
  take(): number {
    const d = this.dirty
    this.dirty = Dirty.NONE
    return d
  }
}
