import type { Effects } from '../effects'
import type { Material } from '../material'
import type { Target } from '../target'

// Dissolve: a Material over the target's boxes, images and glyphs that
// shows each pixel once `progress` passes a threshold from value noise
// (feature size `scale` CSS px, fixed to the page), optionally mixed with
// a sweep across the target's box along `direction`. `softness` is the
// fade width and `edge` a rim in `edgeColor` at the front, both in
// threshold units. Progress 0 hides the target, 1 shows it as usual. The
// target's DOM paint is hidden while enabled, and its records aren't
// drawn until the material's pipelines have compiled (`hold`), so a
// reveal never flashes the finished state.

const FRAGMENT = /* wgsl */ `
fn dsv_hash(p : vec2f) -> f32 {
  let q = fract(p * vec2f(127.1, 311.7));
  return fract(sin(dot(q, vec2f(12.9898, 78.233)) + q.x * q.y) * 43758.5453);
}

fn dsv_noise(p : vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(dsv_hash(i), dsv_hash(i + vec2f(1.0, 0.0)), u.x),
    mix(dsv_hash(i + vec2f(0.0, 1.0)), dsv_hash(i + vec2f(1.0, 1.0)), u.x),
    u.y);
}

fn fragment(m : MatIn) -> vec4f {
  let p = m.page / max(params.scale, 1.0);
  let n = dsv_noise(p) * 0.6 + dsv_noise(p * 2.03 + 7.1) * 0.3
    + dsv_noise(p * 4.01 + 3.7) * 0.1;
  // 0 where the sweep starts, 1 at the far side of the target's box.
  let r = params.rect;
  let uv = clamp((m.page - r.xy) / max(r.zw, vec2f(1.0)), vec2f(0.0), vec2f(1.0));
  var g = n;
  let dl = length(params.direction);
  if (dl > 1e-4) {
    let d = params.direction / dl;
    g = dot(uv - 0.5, d) / max(abs(d.x) + abs(d.y), 1e-4) + 0.5;
  }
  let t = mix(n, g, clamp(params.sweep, 0.0, 1.0));
  let s = max(params.softness, 1e-3);
  let e = max(params.edge, 0.0);
  let k = params.progress * (1.0 + s + e) - t;
  let a = smoothstep(0.0, s, k);
  let rim = select(0.0, 1.0 - smoothstep(s, s + e, k), e > 0.0);
  let ec = vec4f(params.edgeColor.rgb, 1.0) * m.color.a;
  return mix(m.color, ec, rim * params.edgeColor.a) * a;
}
`

const schema = {
  progress: { type: 'f32', default: 0, min: 0, max: 1 },
  scale: { type: 'f32', default: 40, min: 2, max: 400 },
  softness: { type: 'f32', default: 0.1, min: 0, max: 0.5 },
  direction: { type: 'vec2', default: [0, 1] },
  sweep: { type: 'f32', default: 0.35, min: 0, max: 1 },
  edge: { type: 'f32', default: 0, min: 0, max: 0.3 },
  edgeColor: { type: 'color', default: [1, 1, 1, 1] },
  rect: { type: 'vec4', default: [0, 0, 1, 1] }
} as const

export type DissolveSchema = typeof schema

export interface DissolveOptions {
  /** 0 hidden, 1 shown. Default 0. */
  progress?: number
  /** Noise feature size, CSS px. Default 40. */
  scale?: number
  /** Fade width, threshold units. Default 0.1. */
  softness?: number
  /** Sweep direction across the target's box (y down; [0, 1]: top to
   * bottom, the default). [0, 0]: noise only. */
  direction?: [number, number]
  /** 0: noise only, 1: a straight wipe along `direction`. Default 0.35. */
  sweep?: number
  /** Rim width at the dissolve front, threshold units. Default 0 (none). */
  edge?: number
  /** Rim colour (CSS colour or rgba 0..1). Default white. */
  edgeColor?: string | [number, number, number, number]
  /** Don't draw the target until the material has compiled. Default
   * true. */
  hold?: boolean
  enabled?: boolean
  name?: string
}

/** Dissolve `target`'s subtree in (or out) with `progress`. */
export function dissolve(
  fx: Effects,
  target: Target | Element,
  opts: DissolveOptions = {}
): Material<DissolveSchema> {
  const mat = fx.material({
    name: opts.name ?? 'dissolve',
    target,
    fragment: FRAGMENT,
    params: schema,
    enabled: opts.enabled,
    hideSource: true,
    hold: opts.hold ?? true,
    update(m) {
      const r = m.target.rect
      const q = m.params.rect
      if (
        q[0] !== r.x ||
        q[1] !== r.y ||
        q[2] !== r.width ||
        q[3] !== r.height
      ) {
        m.params.rect = [r.x, r.y, r.width, r.height]
      }
    }
  })
  const p = mat.params
  for (const k of ['progress', 'scale', 'softness', 'sweep', 'edge'] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  if (opts.direction) {
    p.direction = [...opts.direction]
  }
  if (opts.edgeColor !== undefined) {
    p.edgeColor = opts.edgeColor as never
  }
  return mat
}
