import type { Effects } from '../effects'
import type { Layer } from '../layer'
import { CLICKS } from '../pointer'
import type { Target } from '../target'

// An expanding ring at each recent click, fed by the pointer's click ring
// buffer (no event code): a Layer of CLICKS quads in document space, so a
// ripple stays where it was clicked while the page scrolls. The layer
// keeps the frame loop alive only while a ripple is running.

const VERTEX = /* wgsl */ `
fn vertex(i : u32, corner : vec2f) -> Quad {
  var q : Quad;
  let c = pointer.clicks[i];
  let t = (fx.time - c.z) / max(params.duration, 1e-3);
  let live = f32(i) < pointer.clicks_n && t >= 0.0 && t < 1.0;
  // Dead instances collapse to a point (no fragments).
  let r = select(0.0, max(params.radius, 1.0) + params.width, live);
  q.pos = c.xy + (corner * 2.0 - 1.0) * r;
  q.uv = (corner * 2.0 - 1.0) * r;
  q.extra = vec4f(t, 0.0, 0.0, 0.0);
  return q;
}
`

const FRAGMENT = /* wgsl */ `
fn fragment(q : Quad, i : u32) -> vec4f {
  let t = q.extra.x;
  // Ease-out growth, linear fade.
  let e = 1.0 - (1.0 - t) * (1.0 - t);
  let ring = abs(length(q.uv) - e * params.radius) - params.width * 0.5;
  let cov = clamp(0.5 - ring * fx.dpr, 0.0, 1.0);
  let a = cov * (1.0 - t) * params.color.a;
  return vec4f(params.color.rgb * a, a);
}
`

const schema = {
  radius: { type: 'f32', default: 80, min: 4, max: 600 },
  width: { type: 'f32', default: 2, min: 0.5, max: 40 },
  duration: { type: 'f32', default: 0.6, min: 0.05, max: 5 },
  color: { type: 'color', default: '#ffffff' }
} as const

export type ClickRippleSchema = typeof schema

export interface ClickRippleOptions {
  /** Final ring radius, CSS px. Default 80. */
  radius?: number
  /** Ring width, CSS px. Default 2. */
  width?: number
  /** Seconds. Default 0.6. */
  duration?: number
  color?: string | number[]
  /** Default 'above'. */
  place?: 'above' | 'below' | { after: Target | Element }
  enabled?: boolean
  name?: string
}

export function clickRipple(
  fx: Effects,
  opts: ClickRippleOptions = {}
): Layer<ClickRippleSchema> {
  const layer = fx.layer({
    name: opts.name ?? 'clickRipple',
    count: CLICKS,
    stride: 1,
    space: 'doc',
    place: opts.place ?? 'above',
    vertex: VERTEX,
    fragment: FRAGMENT,
    params: schema,
    enabled: opts.enabled,
    // Run frames only while the newest click's ripple is alive.
    update(l, time, ctx) {
      const newest = ctx.pointer?.clicks[0]
      l.continuous = newest !== undefined && time - newest.t < l.params.duration
    }
  })
  const p = layer.params
  for (const k of ['radius', 'width', 'duration'] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  if (opts.color !== undefined) {
    ;(p as { color: unknown }).color = opts.color
  }
  return layer
}
