import tgpu from 'typegpu'
import * as d from 'typegpu/data'

// The rounded-box SDFs shared by the box, image and cutout passes
// (docs/TYPEGPU.md).

/** Signed distance to a rounded box (half size b) with per-corner
 * circular radius. */
export const sdRoundBox = tgpu
  .fn(
    [d.vec2f, d.vec2f, d.vec4f],
    d.f32
  )(/* wgsl */ `(p : vec2f, b : vec2f, r4 : vec4f) -> f32 {
  let top = select(r4.x, r4.y, p.x > 0.0);
  let bot = select(r4.w, r4.z, p.x > 0.0);
  let r = select(top, bot, p.y > 0.0);
  let q = abs(p) - b + vec2f(r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - r;
}`)
  .$name('sd_round_box')

/** Signed distance to a rounded box with per-corner elliptical radii
 * (rx4 horizontal, ry4 vertical): the ellipse's first-order distance in
 * the corner regions; circular radii take sd_round_box unchanged.
 * Branch-free (selects only), so callers keep uniform control flow for
 * their derivatives. */
export const sdBox = tgpu
  .fn(
    [d.vec2f, d.vec2f, d.vec4f, d.vec4f],
    d.f32
  )(/* wgsl */ `(p : vec2f, b : vec2f, rx4 : vec4f, ry4 : vec4f) -> f32 {
  let circ = sd_round_box(p, b, rx4);
  let rxt = select(rx4.x, rx4.y, p.x > 0.0);
  let rxb = select(rx4.w, rx4.z, p.x > 0.0);
  let ryt = select(ry4.x, ry4.y, p.x > 0.0);
  let ryb = select(ry4.w, ry4.z, p.x > 0.0);
  let r = vec2f(select(rxt, rxb, p.y > 0.0), select(ryt, ryb, p.y > 0.0));
  let q = abs(p) - b;
  let c = q + r;
  let rs = max(r, vec2f(1e-4));
  let k0 = length(c / rs);
  let k1 = max(length(c / (rs * rs)), 1e-6);
  let corner = c.x > 0.0 && c.y > 0.0 && min(r.x, r.y) > 1e-4;
  let ell = select(min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))),
                   k0 * (k0 - 1.0) / k1, corner);
  return select(ell, circ, all(rx4 == ry4));
}`)
  .$uses({ sd_round_box: sdRoundBox })
  .$name('sd_box')

/** Coverage of a pixel by the inside (d < 0) of an edge; fw = pixel
 * size. */
export const edgeCov = tgpu
  .fn(
    [d.f32, d.f32],
    d.f32
  )(/* wgsl */ `(d : f32, fw : f32) -> f32 {
  return clamp(0.5 - d / fw, 0.0, 1.0);
}`)
  .$name('edge_cov')

/** `sd_round_box` and `sd_box` as WGSL, for passes that still prepend
 * their helpers as text. */
export const SD_BOX_WGSL: string = tgpu.resolve({
  template: 'sdf_prelude',
  externals: {
    sdf_prelude: tgpu['~unstable']
      // The names in this comment pull each item into the resolution.
      .declare('// sd_box')
      .$uses({ sd_box: sdBox })
  }
})

/** `SD_BOX_WGSL` plus `edge_cov`: the box and cutout passes share both, so
 * a hole lines up with a box of the same geometry. */
export const SD_EDGE_WGSL: string = tgpu.resolve({
  template: 'sdf_edge_prelude',
  externals: {
    sdf_edge_prelude: tgpu['~unstable']
      .declare('// sd_box edge_cov')
      .$uses({ sd_box: sdBox, edge_cov: edgeCov })
  }
})
