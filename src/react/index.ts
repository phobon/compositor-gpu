// `compositor-gpu/react`: a provider that runs the page's compositor and
// effects runtime, hooks to reach them, and hooks for the framework-free
// presets. React is an optional peer dependency; nothing here touches the
// DOM or the GPU until the provider mounts on the client, and the
// library itself loads then, by dynamic import.

import {
  createContext,
  createElement,
  type DependencyList,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState
} from 'react'
import type * as FxLib from '../fx/index'
import type { Effects, Trail, TrailOptions } from '../fx/index'
import type { ParamSchema, ParamValues } from '../fx/params'
import type { EdgeLensOptions } from '../fx/presets/edge_lens'
import type { SpotlightOptions } from '../fx/presets/spotlight'
import type {
  TouchTrailParams,
  TouchTrailSchema
} from '../fx/presets/touch_trail'
import type { Compositor, CompositorOptions } from '../types'

export type FxLibrary = typeof FxLib

/** What the provider shares once the compositor runs. */
export interface Gpu {
  compositor: Compositor
  fx: Effects
  /** The `compositor-gpu/fx` module (presets), loaded with the runtime. */
  lib: FxLibrary
  /** The shared pointer trail, when the provider was asked for one. */
  trail: Trail | null
  /** `fx.reducedMotion` (live: a change publishes a new Gpu). */
  reducedMotion: boolean
}

export interface CompositorProviderProps {
  children?: ReactNode
  /** Default true. Off, or without WebGPU, the page is left as is and
   * every hook gets null. Changing it creates or destroys the
   * compositor. */
  enabled?: boolean
  /** createCompositor options. Read when the compositor is created. */
  options?: CompositorOptions
  /** Create one pointer trail for the page (fx.trail), shared through
   * useTrail(). `pointer` defaults to whether the primary pointer can
   * hover (touch moves are scrolls; see useTouchTrail). */
  trail?: boolean | TrailOptions
  /** Show the profiler HUD (compositor.profile.hud()). */
  hud?: boolean
  /** Expose the compositor on `window[global]` for the console. Default
   * '__gpu'; false for none. */
  global?: string | false
  /** Called with the Gpu once running (and again when reducedMotion
   * changes), and with null on teardown. */
  onReady?: (gpu: Gpu | null) => void
}

const GpuContext = createContext<Gpu | null>(null)

const finePointer = (): boolean =>
  window.matchMedia('(hover: hover) and (pointer: fine)').matches

/**
 * Runs a compositor and its effects runtime for the subtree's hooks.
 * Client-only: the library is imported after mount, so SSR and browsers
 * without WebGPU get the plain page. Props other than `enabled` are read
 * when the compositor is created. It renders only its children (no
 * wrapper element) and the context starts null, so server and first
 * client render match whatever `enabled` and `options` are, and a flag
 * read only on the client is safe to pass.
 */
export function CompositorProvider(props: CompositorProviderProps): ReactNode {
  const [gpu, setGpu] = useState<Gpu | null>(null)
  const latest = useRef(props)
  useEffect(() => {
    latest.current = props
  })
  const enabled = props.enabled ?? true

  useEffect(() => {
    if (!enabled || !('gpu' in navigator)) {
      return
    }
    const p = latest.current
    const global = p.global ?? '__gpu'
    const win = window as unknown as Record<string, unknown>
    let cancelled = false
    let published = false
    let compositor: Compositor | null = null
    let fx: Effects | null = null
    let trail: Trail | null = null
    let off = (): void => {}

    Promise.all([import('../index'), import('../fx/index')])
      .then(async ([core, lib]) => {
        if (cancelled) {
          return
        }
        const c = await core.createCompositor(p.options)
        if (cancelled || !c.active) {
          c.destroy()
          return
        }
        compositor = c
        const f = lib.createEffects(c)
        fx = f
        if (p.trail) {
          trail = f.trail({
            pointer: finePointer(),
            ...(p.trail === true ? {} : p.trail)
          })
        }
        c.start()
        if (p.hud) {
          c.profile.hud(true)
        }
        if (global) {
          win[global] = c
        }
        const publish = (reducedMotion: boolean): void => {
          const g = { compositor: c, fx: f, lib, trail, reducedMotion }
          published = true
          setGpu(g)
          latest.current.onReady?.(g)
        }
        publish(f.reducedMotion)
        off = f.onReducedMotion(publish)
      })
      .catch((err: unknown) => {
        console.warn('[compositor-gpu] disabled:', err)
      })

    return () => {
      cancelled = true
      off()
      trail?.destroy()
      fx?.release()
      compositor?.destroy()
      if (global && win[global] === compositor) {
        delete win[global]
      }
      if (published) {
        latest.current.onReady?.(null)
      }
      setGpu(null)
    }
  }, [enabled])

  return createElement(GpuContext.Provider, { value: gpu }, props.children)
}

/** Everything the provider shares, or null before it runs, during SSR,
 * without WebGPU and outside a provider. */
export function useGpu(): Gpu | null {
  return useContext(GpuContext)
}

export function useCompositor(): Compositor | null {
  return useGpu()?.compositor ?? null
}

export function useFx(): Effects | null {
  return useGpu()?.fx ?? null
}

/** The `compositor-gpu/fx` module (presets such as `blur`). */
export function useFxLib(): FxLibrary | null {
  return useGpu()?.lib ?? null
}

/** The provider's shared trail (its `trail` prop). */
export function useTrail(): Trail | null {
  return useGpu()?.trail ?? null
}

type Cleanup = (() => void) | undefined

export interface FxEffectOptions {
  /** Run while the viewer asks for reduced motion. Default false: the
   * effect is skipped then, and set up or torn down when it changes. */
  reducedMotion?: boolean
}

/**
 * useEffect for GPU effects: runs `effect` once the provider's runtime is
 * up (never during SSR or without WebGPU), and its cleanup when the
 * runtime goes, `deps` change, reduced motion turns on, or on unmount.
 */
export function useFxEffect(
  effect: (gpu: Gpu) => Cleanup,
  deps: DependencyList = [],
  opts: FxEffectOptions = {}
): void {
  const gpu = useGpu()
  const allow = opts.reducedMotion ?? false
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's
  useEffect(() => {
    if (!gpu || (gpu.reducedMotion && !allow)) {
      return
    }
    return effect(gpu) ?? undefined
  }, [gpu, allow, ...deps])
}

/** useFxEffect on the element in `ref` (skipped while it is null). */
export function useElementFx<E extends Element>(
  ref: RefObject<E | null>,
  effect: (el: E, gpu: Gpu) => Cleanup,
  deps: DependencyList = [],
  opts: FxEffectOptions = {}
): void {
  useFxEffect(
    (gpu) => {
      const el = ref.current
      return el ? effect(el, gpu) : undefined
    },
    [ref, ...deps],
    opts
  )
}

/** Hook up an effect's live params (a dials panel, a tuning store);
 * returns its undo. Called once, when the effect is created. */
export type Bind<P, S> = (params: P, schema: S) => (() => void) | undefined

type Bound<S extends ParamSchema> = { bind?: Bind<ParamValues<S>, S> }

/** A spotlight (`lib.spotlight`) on the boxes under `ref`. Options are
 * read when it is created. Runs with reduced motion too. */
export function useSpotlight(
  ref: RefObject<Element | null>,
  opts: Omit<SpotlightOptions, 'target'> & Bound<FxLib.SpotlightSchema> = {}
): void {
  const options = useRef(opts)
  useElementFx(
    ref,
    (el, { fx, lib }) => {
      const { bind, ...rest } = options.current
      const mat = lib.spotlight(fx, { ...rest, target: el })
      const unbind = bind?.(mat.params, mat.schema)
      return () => {
        unbind?.()
        mat.destroy()
      }
    },
    [],
    { reducedMotion: true }
  )
}

/** Edge lenses on the viewport (`lib.edgeLens`). Options are read when
 * it is created; `enabled: false` leaves it off. */
export function useEdgeLens(
  opts: EdgeLensOptions & Bound<FxLib.EdgeLensSchema> = {}
): void {
  const options = useRef(opts)
  const on = opts.enabled ?? true
  useFxEffect(
    ({ fx, lib }) => {
      if (!on) {
        return
      }
      const { bind, ...rest } = options.current
      const pass = lib.edgeLens(fx, rest)
      const unbind = bind?.(pass.params, pass.schema)
      return () => {
        unbind?.()
        pass.destroy()
      }
    },
    [on]
  )
}

/** Touch input into the provider's trail (`lib.touchTrail`); nothing
 * without one. Options are read when it is created. */
export function useTouchTrail(
  opts: Partial<TouchTrailParams> & {
    bind?: Bind<TouchTrailParams, TouchTrailSchema>
  } = {}
): void {
  const options = useRef(opts)
  useFxEffect(({ lib, trail }) => {
    if (!trail) {
      return
    }
    const { bind, ...rest } = options.current
    const touch = lib.touchTrail(trail, rest)
    const unbind = bind?.(touch.params, touch.schema)
    return () => {
      unbind?.()
      touch.destroy()
    }
  })
}
