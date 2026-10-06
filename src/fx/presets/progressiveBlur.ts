import type { Effects, Pass } from '../effects'
import type { Target } from '../target'

// Progressive blur: a separable Gaussian whose radius varies with
// position. The amount ramps from 0 at `start` to 1 at `end` (uv over the
// region's border box, or the viewport for a fullscreen pass), shaped by
// `curve`, and scales `radius` (CSS px). Each axis uses the radius at the
// pixel it writes, the usual approximation for a variable blur.

const MAX_TAPS = 24

const AMOUNT = /* wgsl */ `
fn pb_amount(uv : vec2f) -> f32 {
  let d = params.end - params.start;
  let t = clamp(dot(uv - params.start, d) / max(dot(d, d), 1e-6), 0.0, 1.0);
  return pow(t, max(params.curve, 0.01));
}
`

const axis = (dir: string): string => /* wgsl */ `
${AMOUNT}
fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  let r = params.radius * fx.dpr * pb_amount(uv);
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
  radius: { type: 'f32', default: 16, min: 0, max: 64 },
  start: { type: 'vec2', default: [0.5, 1] },
  end: { type: 'vec2', default: [0.5, 0] },
  curve: { type: 'f32', default: 1.5, min: 0.25, max: 4 }
} as const

export type ProgressiveBlurSchema = typeof schema

export interface ProgressiveBlurOptions {
  /** CSS px at full strength. Default 16. */
  radius?: number
  /** uv where the blur starts (0). Default [0.5, 1], the bottom edge. */
  start?: [number, number]
  /** uv where it reaches `radius`. Default [0.5, 0], the top edge. */
  end?: [number, number]
  /** Exponent on the ramp; > 1 keeps the start sharp longer. Default 1.5. */
  curve?: number
  enabled?: boolean
  name?: string
  /** Blur only this element (a region pass). */
  region?: Target | Element
}

export function progressiveBlur(
  fx: Effects,
  opts: ProgressiveBlurOptions = {}
): Pass<ProgressiveBlurSchema> {
  const pass = fx.pass({
    name: opts.name ?? 'progressive-blur',
    fragment: [axis('vec2f(1.0, 0.0)'), axis('vec2f(0.0, 1.0)')],
    params: schema,
    radius: (p) => p.radius,
    enabled: opts.enabled,
    region: opts.region
  })
  const p = pass.params
  if (opts.radius !== undefined) {
    p.radius = opts.radius
  }
  if (opts.start) {
    p.start = [...opts.start]
  }
  if (opts.end) {
    p.end = [...opts.end]
  }
  if (opts.curve !== undefined) {
    p.curve = opts.curve
  }
  return pass
}
