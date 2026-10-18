import type { Effects, Pass } from '../effects'
import type { Target } from '../target'

// Progressive blur: a separable Gaussian whose radius grows toward chosen
// edges of the viewport (or a region's border box). Each edge with a
// weight ramps from 0 at `width` (a uv fraction) inside it to 1 at the
// edge; `corners` blends the union of the x and y ramps (0, bands along
// the edges) toward their product (1, only where an x edge meets a y
// edge). The amount, shaped by `curve`, scales `radius` (CSS px). Each
// axis uses the radius at the pixel it writes, the usual approximation
// for a variable blur.

const MAX_TAPS = 24

const AMOUNT = /* wgsl */ `
fn pb_amount(uv : vec2f) -> f32 {
  let w = max(params.width, vec2f(1e-4));
  let near = clamp(1.0 - vec4f(uv.y, 1.0 - uv.x, 1.0 - uv.y, uv.x) / w.yxyx,
    vec4f(0.0), vec4f(1.0)) * params.edges;
  let x = max(near.y, near.w);
  let y = max(near.x, near.z);
  let t = mix(max(x, y), x * y, clamp(params.corners, 0.0, 1.0));
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
  edges: { type: 'vec4', default: [0, 1, 1, 1] },
  width: { type: 'vec2', default: [0.25, 0.4] },
  corners: { type: 'f32', default: 1, min: 0, max: 1 },
  curve: { type: 'f32', default: 1.5, min: 0.25, max: 4 }
} as const

export type ProgressiveBlurSchema = typeof schema

export interface ProgressiveBlurOptions {
  /** CSS px at full strength. Default 16. */
  radius?: number
  /** Weight per edge: top, right, bottom, left. Default [0, 1, 1, 1]. */
  edges?: [number, number, number, number]
  /** Ramp width as a uv fraction for the left/right and top/bottom
   * edges. Default [0.25, 0.4]. */
  width?: [number, number]
  /** 0: bands along each weighted edge; 1: only where a side edge meets
   * the top/bottom one. Default 1 (with the default edges: the bottom
   * corners). */
  corners?: number
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
  if (opts.edges) {
    p.edges = [...opts.edges]
  }
  if (opts.width) {
    p.width = [...opts.width]
  }
  if (opts.corners !== undefined) {
    p.corners = opts.corners
  }
  if (opts.curve !== undefined) {
    p.curve = opts.curve
  }
  return pass
}
