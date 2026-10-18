import type { Effects, Pass } from '../effects'
import type { Target } from '../target'

// An element's entrance as one region pass driven by `progress` (0
// hidden, 1 settled): it fades in over the first `fade` of progress and,
// as e = (1 - progress)^2 falls to 0, sharpens from a `blur` CSS px
// Gaussian, its red and blue converge from `split` px apart, horizontal
// slices `height` px tall (a `density` share of them) slide back from up
// to `glitch` px, and a `wash` toward `washColor` clears. Tween progress
// (GSAP, Motion; stagger several), then disable or destroy the pass at 1:
// at 1 every term is zero, but the element still renders through its
// own texture while the pass is enabled.

const MAX_TAPS = 12

const AMOUNT = /* wgsl */ `
fn rv_e() -> f32 {
  let t = 1.0 - clamp(params.progress, 0.0, 1.0);
  return t * t;
}
`

const axis = (dir: string): string => /* wgsl */ `${AMOUNT}
fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  let r = params.blur * rv_e() * fx.dpr;
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

const FINISH = /* wgsl */ `${AMOUNT}
fn rv_hash(p : vec2f) -> f32 {
  let q = fract(p * vec2f(127.1, 311.7));
  return fract(sin(dot(q, vec2f(12.9898, 78.233)) + q.x * q.y) * 43758.5453);
}

fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  let e = rv_e();
  let px = uv * fx.viewport / fx.dpr;
  let css = fx.dpr * fx.texel.x;
  var x = 0.0;
  let h = max(params.height, 1.0);
  let band = floor(px.y / h);
  if (rv_hash(vec2f(band, params.seed)) < params.density) {
    x = (rv_hash(vec2f(band + 7.0, params.seed)) * 2.0 - 1.0)
      * params.glitch * e * css;
  }
  let k = params.split * e * css;
  let cr = sample(uv + vec2f(x + k, 0.0));
  let cg = sample(uv + vec2f(x, 0.0));
  let cb = sample(uv + vec2f(x - k, 0.0));
  var c = vec4f(cr.r, cg.g, cb.b, max(max(cr.a, cg.a), cb.a));
  let w = params.wash * e * params.washColor.a;
  c = vec4f(mix(c.rgb, params.washColor.rgb * c.a, w), c.a);
  let f = max(params.fade, 1e-3);
  return c * smoothstep(0.0, f, params.progress);
}
`

const schema = {
  progress: { type: 'f32', default: 0, min: 0, max: 1 },
  blur: { type: 'f32', default: 12, min: 0, max: 48 },
  split: { type: 'f32', default: 8, min: 0, max: 40 },
  glitch: { type: 'f32', default: 24, min: 0, max: 120 },
  height: { type: 'f32', default: 10, min: 1, max: 100 },
  density: { type: 'f32', default: 0.35, min: 0, max: 1 },
  wash: { type: 'f32', default: 0, min: 0, max: 1 },
  fade: { type: 'f32', default: 0.35, min: 0, max: 1 },
  seed: { type: 'f32', default: 0, min: 0, max: 1000 },
  washColor: { type: 'color', default: '#ffffff' }
} as const

export type RevealSchema = typeof schema

export interface RevealOptions {
  /** Default 0 (hidden). */
  progress?: number
  /** Starting blur, CSS px. Default 12. */
  blur?: number
  /** Starting red/blue split, CSS px. Default 8. */
  split?: number
  /** Starting slice shift, CSS px. Default 24. */
  glitch?: number
  /** Slice height, CSS px. Default 10. */
  height?: number
  /** Share of slices shifted. Default 0.35. */
  density?: number
  /** Starting mix toward washColor (a white-out), 0..1. Default 0. */
  wash?: number
  washColor?: string | number[]
  /** Share of progress the fade-in takes. Default 0.35. */
  fade?: number
  /** Picks the slice pattern (vary it per element). */
  seed?: number
  /** Default true. */
  enabled?: boolean
  name?: string
}

export function reveal(
  fx: Effects,
  target: Target | Element,
  opts: RevealOptions = {}
): Pass<RevealSchema> {
  const pass = fx.pass({
    name: opts.name ?? 'reveal',
    fragment: [axis('vec2f(1.0, 0.0)'), axis('vec2f(0.0, 1.0)'), FINISH],
    params: schema,
    // The starting reach (constant, so the group texture keeps its size).
    radius: (p) => Math.max(p.blur, p.glitch + p.split),
    enabled: opts.enabled,
    region: target
  })
  const p = pass.params
  for (const k of [
    'progress',
    'blur',
    'split',
    'glitch',
    'height',
    'density',
    'wash',
    'fade',
    'seed'
  ] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  if (opts.washColor !== undefined) {
    ;(p as { washColor: unknown }).washColor = opts.washColor
  }
  return pass
}
