import type { Effects, Pass } from '../effects'
import type { Target } from '../target'

// Chromatic aberration: red is sampled `amount` CSS px one way, blue the
// other way, green in place. `mode` 0 (radial) offsets along the line from
// `center` (uv, or the eased pointer follower with `followPointer`),
// growing with distance from it up to `amount` at `reach` CSS px; 1
// (linear) offsets along `direction` everywhere. With `radius > 0` the
// split fades out by `radius` CSS px from the centre.

const FRAGMENT = /* wgsl */ `
fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  let css = fx.viewport / fx.dpr;
  let px = uv * css;
  var c = params.center * css;
  if (params.followPointer > 0.5 && pointer.seen > 0.5) {
    c = viewport_to_uv(pointer.follow) * css;
  }
  let d = px - c;
  let len = length(d);
  var off = params.direction * params.amount;
  if (params.mode < 0.5) {
    let dir = select(vec2f(0.0), d / max(len, 1e-3), len > 1e-3);
    off = dir * params.amount * clamp(len / max(params.reach, 1.0), 0.0, 1.0);
  }
  if (params.radius > 0.0) {
    off *= 1.0 - smoothstep(0.0, params.radius, len);
  }
  let o = off * fx.dpr * fx.texel;
  let r = sample(uv + o);
  let g = sample(uv);
  let b = sample(uv - o);
  return vec4f(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}
`

const schema = {
  amount: { type: 'f32', default: 6, min: 0, max: 60 },
  /** Radial: distance in CSS px at which the offset reaches `amount`. */
  reach: { type: 'f32', default: 600, min: 1, max: 2000 },
  /** CSS px from the centre where the split has faded out; 0 = no limit. */
  radius: { type: 'f32', default: 0, min: 0, max: 2000 },
  /** 0 radial, 1 linear. */
  mode: { type: 'f32', default: 0, min: 0, max: 1 },
  followPointer: { type: 'f32', default: 0, min: 0, max: 1 },
  center: { type: 'vec2', default: [0.5, 0.5] },
  /** Linear: unit direction of the red offset. */
  direction: { type: 'vec2', default: [1, 0] }
} as const

export type RgbSplitSchema = typeof schema

export interface RgbSplitOptions {
  /** Largest channel offset, CSS px. Default 6. */
  amount?: number
  reach?: number
  radius?: number
  /** 'radial' (default) or 'linear'. */
  mode?: 'radial' | 'linear'
  /** Centre on the eased pointer follower instead of `center`. */
  followPointer?: boolean
  /** Radial centre in uv. Default the middle. */
  center?: [number, number]
  /** Linear direction. Default [1, 0]. */
  direction?: [number, number]
  enabled?: boolean
  name?: string
  /** Split only this element (a region pass). */
  region?: Target | Element
}

export function rgbSplit(
  fx: Effects,
  opts: RgbSplitOptions = {}
): Pass<RgbSplitSchema> {
  const pass = fx.pass({
    name: opts.name ?? 'rgb-split',
    fragment: FRAGMENT,
    params: schema,
    radius: (p) => p.amount,
    enabled: opts.enabled,
    region: opts.region
  })
  const p = pass.params
  if (opts.mode === 'linear') {
    p.mode = 1
  }
  if (opts.followPointer) {
    p.followPointer = 1
  }
  for (const k of ['amount', 'reach', 'radius'] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  if (opts.center) {
    p.center = opts.center
  }
  if (opts.direction) {
    p.direction = opts.direction
  }
  return pass
}
