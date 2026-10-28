// What made the compositor work, for the profiler (docs/PROFILER.md,
// recorder core): the invalidations DomSync saw between frames (mutation
// records, resizes, loads, animations starting, ...) and the elements a
// frame re-read, as indexes into an element registry: a short selector
// path per element (kept for recordings) and a weak reference to it (for
// pointing at it on the live page). Only fed while the profiler samples.

/** An invalidation between two frames. */
export interface TraceEvent {
  /** 'attributes', 'childList', 'characterData' (mutation records),
   * 'resize' (the root), 'intersection', 'scroll', 'viewport', 'font',
   * 'focus', 'selection', 'load', 'animation', 'animation end',
   * 'invalidate' (an image the mirror waited on), ... */
  kind: string
  /** The element (ElementRegistry index), when there is one. */
  el?: number
  /** E.g. the attribute name, the event type. */
  detail?: string
  /** Times it repeated back to back (absent: once). */
  n?: number
}

/** Why a frame did what it did (FrameSample.why). */
export interface FrameWhy {
  /** Invalidations since the previous frame, oldest first, consecutive
   * repeats folded (up to MAX_EVENTS). */
  events: TraceEvent[]
  /** Events past MAX_EVENTS. */
  more: number
  /** The elements re-read (partial read scopes), up to MAX_SCOPES. */
  scopes: number[]
  scopeCount: number
  /** What kept the frame loop running after this frame ('scroll', 'css
   * animation', an effect's name, ...). */
  alive: string[]
  /** Opacity-group textures this frame: drawn from a kept one (hits),
   * and rendered afresh by reason (gpu/group_cache.ts RenderReason) with
   * the first few elements; absent before 2026-10-28. */
  groups?: FrameGroups
}

export interface FrameGroups {
  hits: number
  why: Record<string, number>
  /** ElementRegistry index (absent for a pseudo-element's node) and
   * reason. */
  els: { el?: number; why: string }[]
}

export const MAX_EVENTS = 12
export const MAX_SCOPES = 16
/** Elements whose live reference is kept; past it the oldest are let go
 * (their paths stay). */
const MAX_LIVE = 8192

/** A short selector for `el`: up to four steps from the nearest ancestor
 * with an id (or the body), each `tag#id.class.class` with
 * `:nth-of-type(k)` when a sibling has the same tag and no id tells them
 * apart. */
export function elPath(el: Element): string {
  const steps: string[] = []
  let e: Element | null = el
  while (e && steps.length < 4) {
    const tag = e.tagName.toLowerCase()
    if (tag === 'html' || tag === 'body') {
      break
    }
    if (e.id) {
      steps.unshift(`${tag}#${e.id}`)
      break
    }
    const cls =
      typeof e.className === 'string'
        ? e.className.trim().split(/\s+/).filter(Boolean).slice(0, 2)
        : []
    let step = `${tag}${cls.map((c) => `.${c}`).join('')}`
    const p: Element | null = e.parentElement
    if (p && cls.length === 0) {
      const same = Array.from(p.children).filter(
        (c) => c.tagName === e?.tagName
      )
      if (same.length > 1) {
        step += `:nth-of-type(${same.indexOf(e) + 1})`
      }
    }
    steps.unshift(step)
    e = p
  }
  return steps.join(' > ') || el.tagName.toLowerCase()
}

/** Elements by index: paths for recordings, weak references for the live
 * page. An element keeps its index (and its path as first seen). */
export class ElementRegistry {
  readonly paths: string[] = []
  private readonly refs = new Map<number, WeakRef<Element>>()
  private readonly ids = new WeakMap<Element, number>()

  id(el: Element): number {
    let i = this.ids.get(el)
    if (i === undefined) {
      i = this.paths.length
      this.paths.push(elPath(el))
      this.ids.set(el, i)
      if (typeof WeakRef !== 'undefined') {
        this.refs.set(i, new WeakRef(el))
        if (this.refs.size > MAX_LIVE) {
          const [oldest] = this.refs.keys()
          if (oldest !== undefined) {
            this.refs.delete(oldest)
          }
        }
      }
    }
    return i
  }

  /** The element behind `i`, while it is still in the document. */
  get(i: number): Element | null {
    const el = this.refs.get(i)?.deref() ?? null
    return el?.isConnected ? el : null
  }
}

/** Invalidations collected between frames. */
export class TraceBuffer {
  private events: TraceEvent[] = []
  private more = 0

  constructor(private readonly registry: ElementRegistry) {}

  note(kind: string, node?: Node | null, detail?: string): void {
    const el =
      node?.nodeType === 1
        ? (node as Element)
        : (node?.parentElement ?? undefined)
    const id = el ? this.registry.id(el) : undefined
    const last = this.events[this.events.length - 1]
    if (
      last &&
      last.kind === kind &&
      last.el === id &&
      last.detail === detail
    ) {
      last.n = (last.n ?? 1) + 1
      return
    }
    if (this.events.length >= MAX_EVENTS) {
      this.more++
      return
    }
    const e: TraceEvent = { kind }
    if (id !== undefined) {
      e.el = id
    }
    if (detail) {
      e.detail = detail
    }
    this.events.push(e)
  }

  /** The events since the last take, and how many didn't fit. */
  take(): { events: TraceEvent[]; more: number } {
    const out = { events: this.events, more: this.more }
    this.events = []
    this.more = 0
    return out
  }

  clear(): void {
    this.events = []
    this.more = 0
  }
}
