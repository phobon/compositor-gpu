import type { Effects } from '../effects'
import type { Material } from '../material'
import type { Target } from '../target'

// Images developing like a print as `progress` goes 0 -> 1: they fade in
// over the first `fade` of progress from washed out toward `washColor`
// (by `wash`) and grey (by `desaturate`), and the colour comes up as
// e = (1 - progress)^2 falls to 0. The page drives `params.progress` and
// destroys the material at 1, where it draws as the plain image. `hold`
// keeps the images hidden until the pipeline compiles.

const FRAGMENT = /* wgsl */ `
fn fragment(m : MatIn) -> vec4f {
  let p = clamp(params.progress, 0.0, 1.0);
  let e = (1.0 - p) * (1.0 - p);
  let c = m.color;
  if (c.a <= 0.0) {
    return c;
  }
  var rgb = c.rgb / c.a;
  let grey = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  rgb = mix(rgb, vec3f(grey), params.desaturate * e);
  rgb = mix(rgb, params.washColor.rgb, params.wash * e * params.washColor.a);
  let a = c.a * smoothstep(0.0, max(params.fade, 1e-3), p);
  return vec4f(rgb * a, a);
}
`

const schema = {
  progress: { type: 'f32', default: 0, min: 0, max: 1 },
  wash: { type: 'f32', default: 0.6, min: 0, max: 1 },
  desaturate: { type: 'f32', default: 1, min: 0, max: 1 },
  fade: { type: 'f32', default: 0.3, min: 0, max: 1 },
  washColor: { type: 'color', default: '#ffffff' }
} as const

export type DevelopSchema = typeof schema

export interface DevelopOptions {
  /** The element whose images develop (its subtree's image records). */
  target: Target | Element
  /** Default 0 (hidden). */
  progress?: number
  /** Starting mix toward washColor. Default 0.6. */
  wash?: number
  /** Starting desaturation. Default 1. */
  desaturate?: number
  /** Share of progress the fade-in takes. Default 0.3. */
  fade?: number
  washColor?: string | number[]
  enabled?: boolean
  name?: string
}

export function develop(
  fx: Effects,
  opts: DevelopOptions
): Material<DevelopSchema> {
  const mat = fx.material({
    name: opts.name ?? 'develop',
    target: opts.target,
    kinds: ['image'],
    params: schema,
    hold: true,
    fragment: FRAGMENT,
    enabled: opts.enabled
  })
  const p = mat.params
  for (const k of ['progress', 'wash', 'desaturate', 'fade'] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  if (opts.washColor !== undefined) {
    ;(p as { washColor: unknown }).washColor = opts.washColor
  }
  return mat
}
