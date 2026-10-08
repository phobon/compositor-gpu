import { type Composer, type Contribution, identity } from './compose'
import type { Target } from './target'

// Layer transforms: move, scale, rotate and fade an element's mirrored
// subtree on the GPU (graph.transform), without touching the DOM. The
// handle's fields are plain numbers, so GSAP (or anything else) can tween
// them; each write schedules a frame. Several transforms and motions on
// one element combine (compose.ts). Without WebGPU nothing happens.

export interface TransformValues {
  /** CSS px. */
  x: number
  y: number
  /** Sets scaleX and scaleY; reads scaleX. */
  scale: number
  scaleX: number
  scaleY: number
  /** Degrees, clockwise. */
  rotate: number
  /** Multiplies the element's own opacity. */
  opacity: number
  /** Fractions of the border box (0.5, 0.5: the centre). */
  originX: number
  originY: number
}

export interface TransformOptions extends Partial<TransformValues> {
  /** Default true. Off: this transform no longer contributes. */
  enabled?: boolean
}

export interface Transform extends TransformValues {
  readonly el: Element
  /** True when the GPU applies it; false on an inert runtime (no WebGPU),
   * where writes are kept and nothing renders: progressive enhancement,
   * the element stays as the page lays it out. */
  readonly gpu: boolean
  enabled: boolean
  /** Stop contributing and release the element. */
  destroy(): void
}

const KEYS = [
  'x',
  'y',
  'scaleX',
  'scaleY',
  'rotate',
  'opacity',
  'originX',
  'originY'
] as const

export function createTransform(
  composer: Composer,
  gpu: boolean,
  target: Target | Element,
  opts: TransformOptions = {}
): Transform {
  const el = target instanceof Element ? target : target.el
  const c: Contribution = { v: identity(), enabled: opts.enabled ?? true }
  const state = c.v
  let destroyed = false
  const changed = (): void => {
    if (!destroyed) {
      composer.update(el)
    }
  }

  const handle = {
    el,
    gpu,
    get enabled() {
      return c.enabled
    },
    set enabled(v: boolean) {
      if (v === c.enabled || destroyed) {
        return
      }
      c.enabled = v
      changed()
    },
    get scale() {
      return state.scaleX
    },
    set scale(v: number) {
      state.scaleX = v
      state.scaleY = v
      changed()
    },
    destroy() {
      if (destroyed) {
        return
      }
      destroyed = true
      remove()
    }
  } as Transform
  for (const k of KEYS) {
    Object.defineProperty(handle, k, {
      enumerable: true,
      get: () => state[k],
      set: (v: number) => {
        state[k] = v
        changed()
      }
    })
  }
  for (const k of [...KEYS, 'scale'] as const) {
    const v = opts[k]
    if (typeof v === 'number') {
      if (k === 'scale') {
        state.scaleX = v
        state.scaleY = v
      } else {
        state[k] = v
      }
    }
  }
  const remove = composer.add(el, c)
  return handle
}
