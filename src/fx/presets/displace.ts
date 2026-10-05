import type { Effects, Pass } from '../effects'
import type { Target } from '../target'

// UV displacement by animated value noise: each pixel samples the scene
// `strength` CSS px away along a noise vector of feature size `scale` CSS
// px, drifting at `speed` (scale units per second). With
// `pointerStrength > 0` the eased pointer follower also warps the scene
// within `pointerRadius` CSS px of it: `mode` 0 is a lens (magnifies), 1 a
// radial push (shoves content outward at a constant strength, folding at
// the centre).

const FRAGMENT = /* wgsl */ `
fn dsp_hash(p : vec2f) -> f32 {
  let q = fract(p * vec2f(127.1, 311.7));
  return fract(sin(dot(q, vec2f(12.9898, 78.233)) + q.x * q.y) * 43758.5453);
}

fn dsp_noise(p : vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = dsp_hash(i);
  let b = dsp_hash(i + vec2f(1.0, 0.0));
  let c = dsp_hash(i + vec2f(0.0, 1.0));
  let d = dsp_hash(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  // CSS px within the viewport, so features keep their size at any dpr.
  let px = uv * fx.viewport / fx.dpr;
  let p = px / max(params.scale, 1.0) + vec2f(fx.time * params.speed);
  let n = vec2f(dsp_noise(p), dsp_noise(p + vec2f(17.3, 9.1))) * 2.0 - 1.0;
  var off = n * params.strength;
  if (params.pointerStrength > 0.0 && pointer.seen > 0.5) {
    let r = max(params.pointerRadius, 1.0);
    // The follower in the same CSS px as px (the viewport, or a region's
    // box).
    let f = viewport_to_uv(pointer.follow) * fx.viewport / fx.dpr;
    let d = px - f;
    let k = 1.0 - smoothstep(0.0, r, length(d));
    if (params.mode < 0.5) {
      // Lens: the shift grows with distance from the follower and fades
      // out by pointerRadius (peak about 0.26 * pointerStrength), so the
      // centre has no fold.
      off += d * k * params.pointerStrength / r;
    } else {
      // Push: a constant-strength outward shove, fading by pointerRadius.
      let dir = select(vec2f(0.0), d / max(length(d), 1e-3), length(d) > 1e-3);
      off += dir * k * params.pointerStrength;
    }
  }
  return sample(uv - off * fx.dpr * fx.texel);
}
`

const schema = {
  strength: { type: 'f32', default: 6, min: 0, max: 40 },
  scale: { type: 'f32', default: 80, min: 4, max: 400 },
  speed: { type: 'f32', default: 0.3, min: 0, max: 4 },
  pointerStrength: { type: 'f32', default: 0, min: 0, max: 80 },
  pointerRadius: { type: 'f32', default: 160, min: 8, max: 600 },
  /** Pointer warp: 0 lens, 1 radial push. */
  mode: { type: 'f32', default: 0, min: 0, max: 1 }
} as const

export type DisplaceSchema = typeof schema

export interface DisplaceOptions {
  strength?: number
  scale?: number
  speed?: number
  pointerStrength?: number
  pointerRadius?: number
  /** 'lens' (default) or 'push'. */
  mode?: 'lens' | 'push'
  enabled?: boolean
  /** Default true: the noise drifts with time. */
  continuous?: boolean
  name?: string
  /** Displace only this element (a region pass). */
  region?: Target | Element
}

export function displace(
  fx: Effects,
  opts: DisplaceOptions = {}
): Pass<DisplaceSchema> {
  const pass = fx.pass({
    name: opts.name ?? 'displace',
    fragment: FRAGMENT,
    params: schema,
    // Samples reach at most strength + pointerStrength CSS px.
    radius: (p) => p.strength + p.pointerStrength,
    enabled: opts.enabled,
    continuous: opts.continuous ?? true,
    region: opts.region
  })
  const p = pass.params
  if (opts.mode === 'push') {
    p.mode = 1
  }
  for (const k of [
    'strength',
    'scale',
    'speed',
    'pointerStrength',
    'pointerRadius'
  ] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  return pass
}
