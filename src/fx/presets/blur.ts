import type { Effects, Pass } from '../effects'
import type { Target } from '../target'

// Separable Gaussian blur: a horizontal then a vertical stage sharing one
// `radius` param (CSS px, the kernel's reach; σ = radius / 3), then a copy.
// From DOWNSAMPLE_AT device px of radius the two blur stages run at half
// resolution and the copy upsamples (bilinear) to full: a quarter of the
// pixels, and half the taps, for a kernel too wide to show the difference.
// Taps are one per source or target texel, whichever is coarser, capped
// at MAX_TAPS per side and spread evenly past that, with the sampler's
// bilinear filter covering the gaps.

const MAX_TAPS = 16
const DOWNSAMPLE_AT = 8

const axis = (dir: string): string => /* wgsl */ `
fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  let r = params.radius * fx.dpr;
  if (r < 0.5) {
    return sample(uv);
  }
  let sigma = r / 3.0;
  let texel = max(max(fx.scale, fx.src_scale), 1.0);
  let n = min(i32(ceil(r / texel)), ${MAX_TAPS});
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

const copy = /* wgsl */ `
fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  return sample(uv);
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
    fragment: [axis('vec2f(1.0, 0.0)'), axis('vec2f(0.0, 1.0)'), copy],
    params: schema,
    radius: (p) => p.radius,
    downsample: (p, dpr) => (p.radius * dpr >= DOWNSAMPLE_AT ? 2 : 1),
    enabled: opts.enabled,
    region: opts.region
  })
  if (opts.radius !== undefined) {
    pass.params.radius = opts.radius
  }
  return pass
}
