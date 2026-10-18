import type { Effects } from '../effects'
import type { Layer } from '../layer'
import type { Target } from '../target'

// A soft radial glow on the eased pointer follower: a one-quad Layer in
// viewport space. `place: 'below'` puts it over the page background and
// under the mirrored content, so it lights up behind text and cards.

const VERTEX = /* wgsl */ `
fn vertex(i : u32, corner : vec2f) -> Quad {
  var q : Quad;
  let r = max(params.radius, 1.0);
  q.pos = pointer.follow + (corner * 2.0 - 1.0) * r;
  q.uv = corner * 2.0 - 1.0;
  return q;
}
`

const FRAGMENT = /* wgsl */ `
fn fragment(q : Quad, i : u32) -> vec4f {
  let d = length(q.uv);
  let k = 1.0 - smoothstep(0.0, 1.0, d);
  let a = params.intensity * k * k * params.color.a * pointer.seen;
  return vec4f(params.color.rgb * a, a);
}
`

const schema = {
  radius: { type: 'f32', default: 160, min: 8, max: 800 },
  intensity: { type: 'f32', default: 0.35, min: 0, max: 1 },
  color: { type: 'color', default: '#ffffff' }
} as const

export type CursorGlowSchema = typeof schema

export interface CursorGlowOptions {
  /** CSS px. Default 160. */
  radius?: number
  /** Peak alpha. Default 0.35. */
  intensity?: number
  /** Default white. */
  color?: string | number[]
  /** Default 'above'. */
  place?: 'above' | 'below' | { after: Target | Element }
  enabled?: boolean
  name?: string
}

export function cursorGlow(
  fx: Effects,
  opts: CursorGlowOptions = {}
): Layer<CursorGlowSchema> {
  const layer = fx.layer({
    name: opts.name ?? 'cursorGlow',
    count: 1,
    stride: 1,
    space: 'viewport',
    place: opts.place ?? 'above',
    vertex: VERTEX,
    fragment: FRAGMENT,
    params: schema,
    enabled: opts.enabled
  })
  const p = layer.params
  if (opts.radius !== undefined) {
    p.radius = opts.radius
  }
  if (opts.intensity !== undefined) {
    p.intensity = opts.intensity
  }
  if (opts.color !== undefined) {
    ;(p as { color: unknown }).color = opts.color
  }
  return layer
}
