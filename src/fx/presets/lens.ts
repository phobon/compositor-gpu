import type { Effects, Pass } from '../effects'
import type { Target } from '../target'

// A fisheye lens: within `radius` CSS px of the centre (the eased pointer
// follower, or `center` in uv with followPointer off) content is
// magnified by up to `strength` at the middle and squeezed toward the rim,
// so text near the edge bends round it; red and blue split radially by up
// to `fringe` CSS px near the rim, fading out over `edge` px outside it.
// Tween `radius` to grow or shrink it (0 draws the page unchanged).

const FRAGMENT = /* wgsl */ `
fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  let css = fx.viewport / fx.dpr;
  let px = uv * css;
  var c = params.center * css;
  if (params.followPointer > 0.5 && pointer.seen > 0.5) {
    c = viewport_to_uv(pointer.follow) * css;
  }
  let R = params.radius;
  let d = px - c;
  let r = length(d);
  if (R <= 0.0 || r >= R + params.edge) {
    return sample(uv);
  }
  var q = px;
  if (r < R) {
    let t = r / R;
    q = c + d * (1.0 - params.strength * (1.0 - t * t));
  }
  let dir = select(vec2f(0.0), d / max(r, 1e-3), r > 1e-3);
  let w = smoothstep(R * 0.6, R, r)
    * (1.0 - smoothstep(R, R + max(params.edge, 1e-3), r));
  let f = dir * params.fringe * w;
  let cr = sample((q + f) / css);
  let cg = sample(q / css);
  let cb = sample((q - f) / css);
  return vec4f(cr.r, cg.g, cb.b, max(max(cr.a, cg.a), cb.a));
}
`

const schema = {
  radius: { type: 'f32', default: 160, min: 0, max: 2000 },
  /** Magnification at the centre: 0 none, toward 1 strong. */
  strength: { type: 'f32', default: 0.4, min: 0, max: 0.95 },
  fringe: { type: 'f32', default: 4, min: 0, max: 40 },
  /** CSS px outside the rim over which the fringe fades. */
  edge: { type: 'f32', default: 24, min: 0, max: 200 },
  followPointer: { type: 'f32', default: 1, min: 0, max: 1 },
  center: { type: 'vec2', default: [0.5, 0.5] }
} as const

export type LensSchema = typeof schema

export interface LensOptions {
  /** CSS px. Default 160. */
  radius?: number
  /** Default 0.4. */
  strength?: number
  /** Largest red/blue split at the rim, CSS px. Default 4. */
  fringe?: number
  /** Default 24. */
  edge?: number
  /** Default true: centred on the eased pointer follower. */
  followPointer?: boolean
  /** Centre in uv when not following the pointer. */
  center?: [number, number]
  enabled?: boolean
  name?: string
  /** Lens only this element (a region pass). */
  region?: Target | Element
}

export function lens(fx: Effects, opts: LensOptions = {}): Pass<LensSchema> {
  const pass = fx.pass({
    name: opts.name ?? 'lens',
    fragment: FRAGMENT,
    params: schema,
    // Magnifying samples move inward; the fringe reaches out by `fringe`.
    radius: (p) => p.fringe,
    enabled: opts.enabled,
    region: opts.region
  })
  const p = pass.params
  if (opts.followPointer === false) {
    p.followPointer = 0
  }
  for (const k of ['radius', 'strength', 'fringe', 'edge'] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  if (opts.center) {
    p.center = opts.center
  }
  return pass
}
