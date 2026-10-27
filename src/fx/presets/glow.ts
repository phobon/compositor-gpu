import type { Effects } from '../effects'
import type { Layer } from '../layer'
import type { Sdf } from '../sdf'
import type { Target } from '../target'

// An outline and outer glow around anything an element draws (text,
// boxes, images, vector svgs), from its distance field (M5e; fx.sdf): a
// stroke `width` px wide, `offset` px out from the shape, and a glow that
// fades over `glow` px past it. One quad over the field, drawn right
// before the element (under it), so the element shows unchanged on top.

const VERTEX = /* wgsl */ `
fn vertex(i : u32, corner : vec2f) -> Quad {
  var q : Quad;
  let r = fx_sdf_info.rect;
  q.pos = r.xy + corner * r.zw;
  q.uv = q.pos;
  return q;
}
`

const FRAGMENT = /* wgsl */ `
fn fragment(q : Quad, i : u32) -> vec4f {
  let d = sdf(q.uv);
  // A device pixel in CSS px, for the stroke's edges.
  let apx = 1.0 / max(fx.dpr, 1e-3);
  if (!sdf_ready()) {
    return vec4f(0.0);
  }
  let h = 0.5 * params.width;
  let mid = params.offset + h;
  let line = clamp((h - abs(d - mid)) / apx + 0.5, 0.0, 1.0) *
    select(0.0, 1.0, params.width > 0.0);
  let past = max(d - params.offset, 0.0);
  // Under the element (drawn before it) the glow runs a few px into the
  // shape, so it meets the edge with no gap; it fades out before the
  // field's reach ends.
  let spread = fx_sdf_info.info.y;
  let g = params.strength * exp(-past / max(params.glow, 1e-3)) *
    clamp((d + 3.0) / 3.0, 0.0, 1.0) *
    (1.0 - smoothstep(0.7 * spread, spread, d)) *
    select(0.0, 1.0, params.glow > 0.0);
  let gc = params.glowColor;
  let lc = params.color;
  let ga = gc.a * g;
  let la = lc.a * line;
  var c = vec4f(gc.rgb * ga, ga);
  c = vec4f(lc.rgb * la, la) + c * (1.0 - la);
  return c;
}
`

const schema = {
  color: { type: 'color', default: '#ffffff' },
  /** Stroke width, CSS px (0: none). */
  width: { type: 'f32', default: 2, min: 0, max: 24 },
  /** Gap between the shape and the stroke, CSS px. */
  offset: { type: 'f32', default: 3, min: 0, max: 40 },
  glowColor: { type: 'color', default: '#7aa2ff' },
  /** Fade length past the offset, CSS px (0: no glow). */
  glow: { type: 'f32', default: 10, min: 0, max: 80 },
  strength: { type: 'f32', default: 0.8, min: 0, max: 1 }
} as const

export type GlowSchema = typeof schema

export interface GlowOptions {
  color?: string
  width?: number
  offset?: number
  glowColor?: string
  glow?: number
  strength?: number
  /** The field's reach, CSS px. Default: room for offset, width and
   * three glow lengths (at least 16). */
  spread?: number
  enabled?: boolean
  name?: string
}

export interface Glow {
  readonly layer: Layer<GlowSchema>
  readonly sdf: Sdf
  enabled: boolean
  destroy(): void
}

export function glow(
  fx: Effects,
  el: Target | Element,
  opts: GlowOptions = {}
): Glow {
  const width = opts.width ?? 2
  const offset = opts.offset ?? 3
  const g = opts.glow ?? 10
  const sdf = fx.sdf(el, {
    spread: opts.spread ?? Math.max(16, Math.ceil(offset + width + 3 * g))
  })
  const layer = fx.layer({
    name: opts.name ?? 'glow',
    count: 1,
    stride: 1,
    place: { before: el },
    sdf,
    params: schema,
    vertex: VERTEX,
    fragment: FRAGMENT,
    enabled: opts.enabled ?? true
  })
  const p = layer.params
  p.width = width
  p.offset = offset
  p.glow = g
  for (const k of ['color', 'glowColor'] as const) {
    const v = opts[k]
    if (v !== undefined) {
      Object.assign(p, { [k]: v })
    }
  }
  if (opts.strength !== undefined) {
    p.strength = opts.strength
  }
  return {
    layer,
    sdf,
    get enabled() {
      return layer.enabled
    },
    set enabled(v: boolean) {
      layer.enabled = v
    },
    destroy() {
      layer.destroy()
      sdf.destroy()
    }
  }
}
