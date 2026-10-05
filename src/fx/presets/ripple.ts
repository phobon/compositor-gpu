import type { Effects } from '../effects'
import type { Material } from '../material'
import type { Target } from '../target'

// Water ripples on an image, one ring per recent click (the pointer's click
// buffer): a fragment-only image Material that samples the image displaced
// along the ring. Nothing moves geometrically, so the element's DOM paint
// stays. Keeps the frame loop alive only while the newest ripple runs.

const FRAGMENT = /* wgsl */ `
fn fragment(m : MatIn) -> vec4f {
  var off = vec2f(0.0);
  let n = u32(pointer.clicks_n);
  for (var i = 0u; i < n; i = i + 1u) {
    let c = pointer.clicks[i];
    let age = fx.time - c.z;
    if (age < 0.0 || age > params.duration) {
      continue;
    }
    let d = m.page - c.xy;
    let r = length(d);
    // A wave packet travelling outward at \`speed\`, fading with age.
    let k = (r - age * params.speed) / max(params.wavelength, 1.0);
    let env = exp(-k * k) * (1.0 - age / params.duration);
    let w = sin(k * 6.2831853) * env * params.amplitude;
    off += select(vec2f(0.0), d / r, r > 1e-3) * w;
  }
  return mat_sample(-off) * m.coverage;
}
`

const schema = {
  amplitude: { type: 'f32', default: 8, min: 0, max: 40 },
  wavelength: { type: 'f32', default: 24, min: 2, max: 200 },
  speed: { type: 'f32', default: 360, min: 10, max: 2000 },
  duration: { type: 'f32', default: 1.2, min: 0.1, max: 5 }
} as const

export type RippleSchema = typeof schema

export interface RippleOptions {
  /** Peak displacement, CSS px. Default 8. */
  amplitude?: number
  /** Ring width, CSS px. Default 24. */
  wavelength?: number
  /** CSS px per second. Default 360. */
  speed?: number
  /** Seconds. Default 1.2. */
  duration?: number
  enabled?: boolean
  name?: string
}

/** Ripples on the images in `target`'s subtree. */
export function ripple(
  fx: Effects,
  target: Target | Element,
  opts: RippleOptions = {}
): Material<RippleSchema> {
  const mat = fx.material({
    name: opts.name ?? 'ripple',
    target,
    kinds: ['image'],
    fragment: FRAGMENT,
    params: schema,
    enabled: opts.enabled,
    update(m, time, ctx) {
      const newest = ctx.pointer?.clicks[0]
      m.continuous = newest !== undefined && time - newest.t < m.params.duration
    }
  })
  const p = mat.params
  for (const k of ['amplitude', 'wavelength', 'speed', 'duration'] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  return mat
}
