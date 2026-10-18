import type { Effects, Pass } from '../effects'

// A lens along the top and bottom edges of the viewport: a band at each
// edge (`topBand` / `bottomBand` × the viewport height) magnifies toward
// that edge's centre by up to `top` / `bottom`, so the page swells as it
// scrolls in and out. It fades in from the band's inner edge, so the
// middle of the page is untouched. Viewport-fixed: with the default
// page-anchored canvas the bands lag a frame behind momentum scrolling,
// so pair it with `canvasPin: 'viewport'`.

const FRAGMENT = /* wgsl */ `
fn edge_lens(p : vec2f, edge_y : f32, e : f32, s : f32, vp : vec2f) -> vec2f {
  let t = smoothstep(0.0, 1.0, clamp(e, 0.0, 1.0));
  let c = vec2f(vp.x * 0.5, edge_y);
  return c + (p - c) * (1.0 - s * t);
}

fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  let vp = fx.viewport / fx.dpr;
  let p = uv_to_viewport(uv);
  let hb = max(params.bottomBand * vp.y, 1.0);
  let ht = max(params.topBand * vp.y, 1.0);
  var q = p;
  if (p.y > vp.y - hb) {
    q = edge_lens(p, vp.y, (p.y - (vp.y - hb)) / hb, params.bottom, vp);
  } else if (p.y < ht) {
    q = edge_lens(p, 0.0, (ht - p.y) / ht, params.top, vp);
  } else {
    return sample(uv);
  }
  return sample(viewport_to_uv(clamp(q, vec2f(0.0), vp)));
}
`

const schema = {
  top: { type: 'f32', default: 0.15, min: 0, max: 0.9 },
  topBand: { type: 'f32', default: 0.2, min: 0.05, max: 0.5 },
  bottom: { type: 'f32', default: 0.15, min: 0, max: 0.9 },
  bottomBand: { type: 'f32', default: 0.2, min: 0.05, max: 0.5 }
} as const

export type EdgeLensSchema = typeof schema

export interface EdgeLensOptions {
  /** Magnification at the top edge, 0..0.9. Default 0.15. */
  top?: number
  /** Top band height, × the viewport's. Default 0.2. */
  topBand?: number
  /** Magnification at the bottom edge. Default 0.15. */
  bottom?: number
  /** Bottom band height, × the viewport's. Default 0.2. */
  bottomBand?: number
  enabled?: boolean
  name?: string
}

export function edgeLens(
  fx: Effects,
  opts: EdgeLensOptions = {}
): Pass<EdgeLensSchema> {
  const pass = fx.pass({
    name: opts.name ?? 'edge-lens',
    params: schema,
    // Samples are clamped to the viewport.
    radius: 0,
    fragment: FRAGMENT,
    enabled: opts.enabled
  })
  const p = pass.params
  for (const k of ['top', 'topBand', 'bottom', 'bottomBand'] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  return pass
}
