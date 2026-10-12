import type { MaterialKind } from '../../gpu/material'
import type { Effects } from '../effects'
import type { Material } from '../material'
import type { Target } from '../target'

// Light around the eased pointer, inside each record it falls on: added
// over the record's own colour (premultiplied over), times its edge
// coverage so it never leaves the shape, brighter in a rim just inside
// the edge. A Material, so it is clipped to each box's rounded shape and
// drawn under whatever paints over the box.

const FRAGMENT = /* wgsl */ `
fn fragment(m : MatIn) -> vec4f {
  let p = m.page - fx.scroll;
  let d = distance(p, pointer.follow);
  let fall = 1.0 - smoothstep(0.0, params.radius, d);
  let rim = (1.0 - smoothstep(0.0, params.rimWidth, -m.dist)) *
    params.rim;
  let a = clamp(fall * fall * params.intensity * (1.0 + rim), 0.0, 1.0) *
    m.coverage * pointer.seen;
  return vec4f(params.color.rgb * a, a) + m.color * (1.0 - a);
}
`

const schema = {
  radius: { type: 'f32', default: 280, min: 40, max: 800 },
  intensity: { type: 'f32', default: 0.35, min: 0, max: 1 },
  rim: { type: 'f32', default: 1.5, min: 0, max: 6 },
  rimWidth: { type: 'f32', default: 2, min: 0.5, max: 16 },
  color: { type: 'color', default: '#ffffff' }
} as const

export type SpotlightSchema = typeof schema

export interface SpotlightOptions {
  /** The element whose subtree is lit. */
  target: Target | Element
  /** CSS px. Default 280. */
  radius?: number
  /** Peak alpha, 0..1. Default 0.35. */
  intensity?: number
  /** Extra light in the rim, × intensity. Default 1.5. */
  rim?: number
  /** Rim width, CSS px. Default 2. */
  rimWidth?: number
  /** Default white. */
  color?: string | number[]
  /** Record kinds lit. Default boxes only. */
  kinds?: readonly MaterialKind[]
  enabled?: boolean
  name?: string
}

export function spotlight(
  fx: Effects,
  opts: SpotlightOptions
): Material<SpotlightSchema> {
  const mat = fx.material({
    name: opts.name ?? 'spotlight',
    target: opts.target,
    kinds: opts.kinds ?? ['box'],
    fragment: FRAGMENT,
    params: schema,
    enabled: opts.enabled
  })
  const p = mat.params
  for (const k of ['radius', 'intensity', 'rim', 'rimWidth'] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  if (opts.color !== undefined) {
    ;(p as { color: unknown }).color = opts.color
  }
  return mat
}
