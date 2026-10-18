import type { Effects, Pass } from '../effects'
import type { Target } from '../target'

// Horizontal slice glitch: the viewport (or a region's box) is cut into
// bands about `height` CSS px tall (irregular: each group of three is
// jittered), and a `density` share of them shift sideways by up to
// `amount` CSS px, with their red and blue channels split a further
// `split` px. The pattern reseeds `rate` times a second (0 holds it);
// `seed` picks another one. Tween `amount` and `split` to 0 to settle.

const FRAGMENT = /* wgsl */ `
fn gls_hash(p : vec2f) -> f32 {
  let q = fract(p * vec2f(127.1, 311.7));
  return fract(sin(dot(q, vec2f(12.9898, 78.233)) + q.x * q.y) * 43758.5453);
}

fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  let px = uv * fx.viewport / fx.dpr;
  let h = max(params.height, 1.0);
  let tick = floor(fx.time * params.rate) + params.seed;
  let y = px.y + gls_hash(vec2f(floor(px.y / (h * 3.0)), tick)) * h;
  let band = floor(y / h);
  let r = gls_hash(vec2f(band, tick + 0.37));
  if (r >= params.density) {
    return sample(uv);
  }
  let s = gls_hash(vec2f(band + 11.0, tick)) * 2.0 - 1.0;
  let css = fx.dpr * fx.texel.x;
  let x = s * params.amount * css;
  let k = params.split * css * sign(s);
  let cr = sample(uv + vec2f(x + k, 0.0));
  let cg = sample(uv + vec2f(x, 0.0));
  let cb = sample(uv + vec2f(x - k, 0.0));
  return vec4f(cr.r, cg.g, cb.b, max(max(cr.a, cg.a), cb.a));
}
`

const schema = {
  amount: { type: 'f32', default: 24, min: 0, max: 200 },
  height: { type: 'f32', default: 14, min: 1, max: 200 },
  density: { type: 'f32', default: 0.3, min: 0, max: 1 },
  split: { type: 'f32', default: 4, min: 0, max: 40 },
  rate: { type: 'f32', default: 12, min: 0, max: 60 },
  seed: { type: 'f32', default: 0, min: 0, max: 1000 }
} as const

export type GlitchSlicesSchema = typeof schema

export interface GlitchSlicesOptions {
  /** Largest sideways shift, CSS px. Default 24. */
  amount?: number
  /** Band height, CSS px. Default 14. */
  height?: number
  /** Share of bands shifted, 0..1. Default 0.3. */
  density?: number
  /** Extra red/blue offset in shifted bands, CSS px. Default 4. */
  split?: number
  /** Reseeds per second; 0 holds the pattern. Default 12. */
  rate?: number
  seed?: number
  enabled?: boolean
  /** Default true (the pattern reseeds with time). */
  continuous?: boolean
  name?: string
  /** Glitch only this element (a region pass). */
  region?: Target | Element
}

export function glitchSlices(
  fx: Effects,
  opts: GlitchSlicesOptions = {}
): Pass<GlitchSlicesSchema> {
  const pass = fx.pass({
    name: opts.name ?? 'glitch-slices',
    fragment: FRAGMENT,
    params: schema,
    radius: (p) => p.amount + p.split,
    enabled: opts.enabled,
    continuous: opts.continuous ?? true,
    region: opts.region
  })
  const p = pass.params
  for (const k of [
    'amount',
    'height',
    'density',
    'split',
    'rate',
    'seed'
  ] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  return pass
}
