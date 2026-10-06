// The rounded-box SDF with elliptical corners, shared by the box, image
// and cutout passes. Each module defines `sd_round_box` (circular) first.

export const SD_BOX_WGSL = /* wgsl */ `
// Signed distance to a rounded box with per-corner elliptical radii (rx4
// horizontal, ry4 vertical): the ellipse's first-order distance in the
// corner regions. Circular radii take sd_round_box unchanged.
// Branch-free (selects only), so callers keep uniform control flow for
// their derivatives.
fn sd_box(p : vec2f, b : vec2f, rx4 : vec4f, ry4 : vec4f) -> f32 {
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
}
`
