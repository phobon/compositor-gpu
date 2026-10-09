import type { Effects, Pass } from '../effects'
import type { Target } from '../target'

// Separable Gaussian blur: a horizontal then a vertical stage sharing one
// `radius` param (CSS px, the kernel's reach; σ = radius / 3). Taps are
// capped at MAX_TAPS per side and spread evenly past that, with the
// sampler's bilinear filter covering the gaps (radii up to MAX_TAPS
// device px sample every texel).

const MAX_TAPS = 16

const axis = (dir: string): string => /* wgsl */ `
fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  let r = params.radius * fx.dpr;
  if (r < 0.5) {
    return sample(uv);
  }
  let sigma = r / 3.0;
  let n = min(i32(ceil(r)), ${MAX_TAPS});
  let step = r / f32(n);
  let d = ${dir} * fx.texel * step;
  var acc = vec4f(0.0);
  var wsum = 0.0;
  for (var i = -n; i <= n; i++) {
    let x = f32(i) * step;
    let w = exp(-0.5 * x * x / (sigma * sigma));
    acc += w * sample(uv + d * f32(i));
    wsum += w;
  }
  return acc / wsum;
}
`

const schema = {
  radius: { type: 'f32', default: 8, min: 0, max: 64 }
} as const

export type BlurSchema = typeof schema

export interface BlurOptions {
  /** CSS px. Default 8. */
  radius?: number
  enabled?: boolean
  name?: string
  /** Blur only this element (a region pass). */
  region?: Target | Element
}

export function blur(fx: Effects, opts: BlurOptions = {}): Pass<BlurSchema> {
  const pass = fx.pass({
    name: opts.name ?? 'blur',
    fragment: [axis('vec2f(1.0, 0.0)'), axis('vec2f(0.0, 1.0)')],
    params: schema,
    radius: (p) => p.radius,
    enabled: opts.enabled,
    region: opts.region
  })
  if (opts.radius !== undefined) {
    pass.params.radius = opts.radius
  }
  return pass
}
