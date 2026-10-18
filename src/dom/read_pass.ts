import type { Rect, RGBA, Space } from '../scene/records'
import type { RunStyle } from './text_runs'

// One read of the DOM (SceneReader.fullRead / partialRead): what holds for
// the whole synchronous pass and nothing longer. The scroll offset
// (`window.scrollX/Y` are native getters and were ~19% of a full read when
// called once per glyph), the selection's ranges, and caches keyed by
// computed style or element, which can't change within a pass. Reads take
// a view for the space they measure into (`at`), so the space travels with
// the argument rather than in shared state.

/** Text-read counts for one pass (`stats().textRead`). */
export interface TextReadStats {
  /** Graphemes given a glyph. */
  graphemes: number
  /** Of those, read with their own Range (not split from a chunk). */
  perGrapheme: number
  /** Range layout queries issued. */
  ranges: number
}

/** A read pass measuring into one space (see records.ts). */
export interface ReadView {
  readonly pass: ReadPass
  readonly space: Space
  /** Viewport-relative client rect -> this space: document space (CSS px
   * from the document's top-left) or viewport space. */
  docRect(r: DOMRectReadOnly): Rect
}

class View implements ReadView {
  constructor(
    readonly pass: ReadPass,
    readonly space: Space,
    private readonly ox: number,
    private readonly oy: number
  ) {}

  docRect(r: DOMRectReadOnly): Rect {
    return {
      x: r.left + this.ox,
      y: r.top + this.oy,
      width: r.width,
      height: r.height
    }
  }
}

export class ReadPass {
  readonly stats: TextReadStats = { graphemes: 0, perGrapheme: 0, ranges: 0 }
  /** text_runs.ts: an element's text nodes share its computed style
   * object. */
  readonly runStyles = new WeakMap<CSSStyleDeclaration, RunStyle>()
  /** selection.ts: highlight colour and line height per element. */
  readonly selectionStyles = new Map<Element, { fill: RGBA; lh: number }>()
  /** selection.ts: selected text colour per element (null: its own). */
  readonly selectionText = new Map<Element, RGBA | null>()
  private readonly doc: View
  private readonly viewport: View

  /** `ranges`: the selection's (none when collapsed). */
  constructor(
    readonly scrollX: number,
    readonly scrollY: number,
    readonly ranges: readonly Range[] = []
  ) {
    this.doc = new View(this, 'doc', scrollX, scrollY)
    this.viewport = new View(this, 'viewport', 0, 0)
  }

  /** A pass over the live document: its scroll and selection now. */
  static fromDocument(): ReadPass {
    const ranges: Range[] = []
    const sel = document.getSelection()
    if (sel && !sel.isCollapsed) {
      for (let i = 0; i < sel.rangeCount; i++) {
        ranges.push(sel.getRangeAt(i))
      }
    }
    return new ReadPass(window.scrollX, window.scrollY, ranges)
  }

  at(space: Space): ReadView {
    return space === 'viewport' ? this.viewport : this.doc
  }
}
