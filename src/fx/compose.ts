import type { LayerTransform, RenderGraph } from '../gpu/graph'

// Several effects on one element share its layer transform: each is a
// Contribution with its own channels, and the composer combines the
// enabled ones into the single LayerTransform the graph reads (x, y and
// rotate add; scaleX, scaleY and opacity multiply; the origin is the
// first enabled contribution's). Nested elements get nested layers.

export type Channels = LayerTransform

export const identity = (): Channels => ({
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  rotate: 0,
  opacity: 1,
  originX: 0.5,
  originY: 0.5
})

export interface Contribution {
  readonly v: Channels
  enabled: boolean
}

export interface Composer {
  /** Register `c` on `el`; returns its removal. */
  add(el: Element, c: Contribution): () => void
  /** Re-combine `el` after a contribution's channels or `enabled`
   * changed. */
  update(el: Element): void
  /** Detach every element (runtime teardown). */
  clear(): void
}

interface Slot {
  contribs: Set<Contribution>
  /** The combined transform, handed to the graph by reference. */
  state: Channels
  attached: boolean
}

/** A composer over `graph`; with none (inert), every call is a no-op. */
export function createComposer(graph: RenderGraph | null): Composer {
  const slots = new Map<Element, Slot>()

  const update = (el: Element): void => {
    const slot = slots.get(el)
    if (!slot || !graph) {
      return
    }
    const s = slot.state
    Object.assign(s, identity())
    let any = false
    for (const c of slot.contribs) {
      if (!c.enabled) {
        continue
      }
      const v = c.v
      if (!any) {
        s.originX = v.originX
        s.originY = v.originY
      }
      any = true
      s.x += v.x
      s.y += v.y
      s.rotate += v.rotate
      s.scaleX *= v.scaleX
      s.scaleY *= v.scaleY
      s.opacity *= v.opacity
    }
    if (any !== slot.attached) {
      slot.attached = any
      graph.transform(el, any ? s : null)
    } else if (any) {
      graph.requestFrame()
    }
  }

  return {
    add(el, c) {
      let slot = slots.get(el)
      if (!slot) {
        slot = { contribs: new Set(), state: identity(), attached: false }
        slots.set(el, slot)
      }
      slot.contribs.add(c)
      update(el)
      return () => {
        const sl = slots.get(el)
        if (!sl?.contribs.delete(c)) {
          return
        }
        update(el)
        if (sl.contribs.size === 0) {
          slots.delete(el)
        }
      }
    },
    update,
    clear() {
      for (const [el, slot] of slots) {
        if (slot.attached && graph) {
          graph.transform(el, null)
        }
      }
      slots.clear()
    }
  }
}
