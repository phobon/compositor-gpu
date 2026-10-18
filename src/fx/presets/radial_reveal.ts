import type { Effects } from '../effects'
import type { Transition } from '../transition'

// A transition: a circle grows from `center` (uv; by default the pointer
// at capture()) and shows the incoming page inside it, the outgoing one
// outside, with a `soft` CSS px edge. Around the edge, within `band` px,
// both pages bend inward by up to `warp` px (a lens at the rim) and red
// and blue split by up to `fringe` px. The warp and fringe peak half way
// and vanish at progress 0 and 1, so the ends are exactly the two pages.

const FRAGMENT = /* wgsl */ `
fn rr_at(uv : vec2f, c : vec2f, css : vec2f, r : f32) -> vec4f {
  let s = max(params.soft, 1e-3);
  let k = smoothstep(r - s, r, length(uv * css - c));
  // Exact at either side (mix may round where k is 0 or 1).
  if (k >= 1.0) {
    return prev(uv);
  }
  if (k <= 0.0) {
    return sample(uv);
  }
  return mix(sample(uv), prev(uv), k);
}

fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  let css = fx.viewport / fx.dpr;
  let c = params.center * css;
  let far = length(max(c, css - c)) + max(params.soft, 1e-3);
  let pr = clamp(params.progress, 0.0, 1.0);
  let r = pr * far;
  let d = uv * css - c;
  let len = length(d);
  let dir = select(vec2f(0.0), d / max(len, 1e-3), len > 1e-3);
  let amp = 4.0 * pr * (1.0 - pr);
  let w = amp * (1.0 - smoothstep(0.0, max(params.band, 1.0), abs(len - r)));
  let q = uv - dir * params.warp * w / css;
  let f = dir * params.fringe * w / css;
  let cr = rr_at(q + f, c, css, r);
  let cg = rr_at(q, c, css, r);
  let cb = rr_at(q - f, c, css, r);
  return vec4f(cr.r, cg.g, cb.b, max(max(cr.a, cg.a), cb.a));
}
`

const schema = {
  progress: { type: 'f32', default: 0, min: 0, max: 1 },
  center: { type: 'vec2', default: [0.5, 0.5] },
  soft: { type: 'f32', default: 48, min: 0, max: 400 },
  band: { type: 'f32', default: 120, min: 1, max: 600 },
  warp: { type: 'f32', default: 24, min: 0, max: 200 },
  fringe: { type: 'f32', default: 6, min: 0, max: 60 }
} as const

export type RadialRevealSchema = typeof schema

export interface RadialRevealOptions {
  /** Edge softness, CSS px. Default 48. */
  soft?: number
  /** Width of the bending band around the edge, CSS px. Default 120. */
  band?: number
  /** Largest inward bend at the edge, CSS px. Default 24. */
  warp?: number
  /** Largest red/blue split at the edge, CSS px. Default 6. */
  fringe?: number
  /** Default true: capture() centres the circle on the pointer (the
   * middle until it has moved). False: `params.center` as set. */
  fromPointer?: boolean
  /** ms settled() waits at most. Default 1500. */
  timeout?: number
  name?: string
}

export function radialReveal(
  fx: Effects,
  opts: RadialRevealOptions = {}
): Transition<RadialRevealSchema> {
  const t = fx.transition({
    name: opts.name ?? 'radial-reveal',
    fragment: FRAGMENT,
    params: schema,
    timeout: opts.timeout
  })
  const p = t.params
  for (const k of ['soft', 'band', 'warp', 'fringe'] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  if (opts.fromPointer !== false) {
    const capture = t.capture
    t.capture = () => {
      const ptr = fx.pointer
      if (ptr.seen) {
        p.center = [ptr.x / window.innerWidth, ptr.y / window.innerHeight]
      }
      p.progress = 0
      return capture()
    }
  }
  return t
}
