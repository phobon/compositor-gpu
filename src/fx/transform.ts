import type { LayerTransform, RenderGraph } from '../gpu/graph'
import type { Target } from './target'

// Layer transforms: move, scale, rotate and fade an element's mirrored
// subtree on the GPU (graph.transform), without touching the DOM. The
// handle's fields are plain numbers, so GSAP (or anything else) can tween
// them; each write schedules a frame. Without WebGPU the same writes go to
// the element's CSS transform and opacity instead (`fallback: 'dom'`).

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
  /** Default true. Off: the element renders in place (not isolated). */
  enabled?: boolean
  /** Without WebGPU: 'dom' (default) writes CSS `transform`, `opacity`
   * and `transform-origin` on the element; 'none' does nothing. */
  fallback?: 'dom' | 'none'
}

export interface Transform extends TransformValues {
  readonly el: Element
  /** True when the GPU applies it (else the DOM fallback, or nothing). */
  readonly gpu: boolean
  enabled: boolean
  /** Back to identity and release the element (and restore its style
   * under the DOM fallback). */
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

type Styled = Element & ElementCSSInlineStyle

export function createTransform(
  graph: RenderGraph | null,
  target: Target | Element,
  opts: TransformOptions = {}
): Transform {
  const el = target instanceof Element ? target : target.el
  const state: LayerTransform = {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotate: 0,
    opacity: 1,
    originX: 0.5,
    originY: 0.5
  }
  const dom = !graph && (opts.fallback ?? 'dom') === 'dom' && 'style' in el
  const style = dom ? (el as Styled).style : null
  // The element's inline values when the fallback took over, and its
  // computed transform and opacity then (composed with, as the GPU path
  // composes with them).
  let saved: {
    transform: string
    opacity: string
    origin: string
    baseTransform: string
    baseOpacity: number
  } | null = null
  let enabled = opts.enabled ?? true
  let destroyed = false

  const restore = (): void => {
    if (style && saved) {
      style.transform = saved.transform
      style.opacity = saved.opacity
      style.transformOrigin = saved.origin
    }
  }
  const writeDom = (): void => {
    if (!style) {
      return
    }
    if (!enabled) {
      restore()
      saved = null
      return
    }
    if (!saved) {
      const cs = getComputedStyle(el)
      const o = Number.parseFloat(cs.opacity)
      saved = {
        transform: style.transform,
        opacity: style.opacity,
        origin: style.transformOrigin,
        baseTransform: cs.transform === 'none' ? '' : cs.transform,
        baseOpacity: Number.isFinite(o) ? o : 1
      }
    }
    const s = state
    if (
      s.x === 0 &&
      s.y === 0 &&
      s.scaleX === 1 &&
      s.scaleY === 1 &&
      s.rotate % 360 === 0 &&
      s.opacity === 1
    ) {
      // At rest: the element's own styles, as the GPU path draws it.
      restore()
      return
    }
    style.transformOrigin = `${s.originX * 100}% ${s.originY * 100}%`
    style.transform =
      `translate(${s.x}px, ${s.y}px) rotate(${s.rotate}deg) scale(${s.scaleX}, ${s.scaleY}) ${saved.baseTransform}`.trim()
    style.opacity = String(saved.baseOpacity * s.opacity)
  }
  const changed = (): void => {
    if (destroyed) {
      return
    }
    if (graph) {
      graph.requestFrame()
    } else {
      writeDom()
    }
  }
  const attach = (): void => {
    if (graph) {
      graph.transform(el, enabled ? state : null)
    } else {
      writeDom()
    }
  }

  const handle = {
    el,
    gpu: graph !== null,
    get enabled() {
      return enabled
    },
    set enabled(v: boolean) {
      if (v === enabled || destroyed) {
        return
      }
      enabled = v
      attach()
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
      enabled = false
      attach()
      destroyed = true
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
  attach()
  return handle
}
