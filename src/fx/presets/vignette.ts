import type { Effects, Pass } from '../effects'

// Vignette and flash, over the visible viewport. The vignette mixes
// toward `color` by up to `amount`, from `inner` to `outer` (distance from
// `center` in uv, scaled so the corners of a centred vignette are 1).
// `flash` then mixes the whole result toward `flashColor` (a white-out,
// or a fade to black), so transitions can tween it.

const FRAGMENT = /* wgsl */ `
fn vig_over(c : vec4f, col : vec4f, k : f32) -> vec4f {
  let a = col.a * k;
  return c * (1.0 - a) + vec4f(col.rgb * a, a);
}

fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  let d = length((uv - params.center) * 2.0) * 0.70710678;
  let k = smoothstep(params.inner, max(params.outer, params.inner + 1e-3), d);
  let c = vig_over(sample(uv), params.color, k * params.amount);
  return vig_over(c, params.flashColor, params.flash);
}
`

const schema = {
  amount: { type: 'f32', default: 0.5, min: 0, max: 1 },
  inner: { type: 'f32', default: 0.45, min: 0, max: 2 },
  outer: { type: 'f32', default: 1.1, min: 0, max: 2 },
  flash: { type: 'f32', default: 0, min: 0, max: 1 },
  center: { type: 'vec2', default: [0.5, 0.5] },
  color: { type: 'color', default: '#000000' },
  flashColor: { type: 'color', default: '#ffffff' }
} as const

export type VignetteSchema = typeof schema

export interface VignetteOptions {
  /** Strength at `outer`, 0..1. Default 0.5. */
  amount?: number
  /** Where darkening starts. Default 0.45. */
  inner?: number
  /** Where it reaches `amount`. Default 1.1. */
  outer?: number
  /** Whole-viewport mix toward `flashColor`, 0..1. Default 0. */
  flash?: number
  center?: [number, number]
  color?: string | number[]
  flashColor?: string | number[]
  enabled?: boolean
  name?: string
}

export function vignette(
  fx: Effects,
  opts: VignetteOptions = {}
): Pass<VignetteSchema> {
  const pass = fx.pass({
    name: opts.name ?? 'vignette',
    fragment: FRAGMENT,
    params: schema,
    radius: 0,
    enabled: opts.enabled
  })
  const p = pass.params
  for (const k of ['amount', 'inner', 'outer', 'flash'] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  if (opts.center) {
    p.center = opts.center
  }
  if (opts.color !== undefined) {
    ;(p as { color: unknown }).color = opts.color
  }
  if (opts.flashColor !== undefined) {
    ;(p as { flashColor: unknown }).flashColor = opts.flashColor
  }
  return pass
}
