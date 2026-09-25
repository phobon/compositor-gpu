import { FRAME_WGSL } from '../../gpu/frame'

/**
 * Slug fragment shader.
 *
 * Provenance: adapted from Eric Lengyel's Slug reference shaders, released to
 * the public domain (US patent 10,373,352 disclaimed March 2026; reference
 * code MIT). Per pixel we transform to em space, pick the band by em.y, and
 * accumulate signed sub-pixel analytic coverage from the quadratic curves
 * crossing the pixel's scanline — the horizontal distance to each crossing,
 * not a hard nonzero-winding test — with a 3-tap vertical supersample for
 * anti-aliasing. Validated by the visual-regression harness (`npm run
 * test:visual`) plus offline WGSL validation with `naga`.
 *
 * Bind group 1:
 *   0 glyphs : per-instance {rect, offset, color, gref, clip, xf0, xf1}
 *   1 bands  : {yMin, yMax, curveStart, curveEnd} per glyph-band
 *   2 curves : {p0.xy, p1.xy, c.xy} quadratic control points
 */
export const SLUG_WGSL = /* wgsl */ `
${FRAME_WGSL}

struct Glyph {
  rect   : vec4f,   // ink box x,y,w,h in the glyph's local line-box frame
  offset : vec4f,   // xy displacement, space (1 = viewport), _
  color  : vec4f,
  gref   : vec4u,   // bandStart, bandCount, _, _
  clip   : vec4f,   // minX, minY, maxX, maxY (the record's space)
  xf0    : vec4f,   // a, b, c, d: linear part of local -> doc
  xf1    : vec4f,   // tx, ty (doc space), _, _
};
struct Band  { bounds : vec4f, };        // yMin, yMax, curveStart, curveEnd
struct Curve { p : vec4f, c : vec4f, };  // x0,y0,x1,y1 ; cx,cy,_,_

@group(1) @binding(0) var<storage, read> glyphs : array<Glyph>;
@group(1) @binding(1) var<storage, read> bands  : array<Band>;
@group(1) @binding(2) var<storage, read> curves : array<Curve>;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) em : vec2f,                 // 0..1 within the em box, y-up
  @location(1) @interpolate(flat) idx : u32,
  @location(2) docp : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32,
      @builtin(instance_index) ii : u32) -> VOut {
  var uv = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let g = glyphs[ii];
  let corner = uv[vi];
  let lp = g.rect.xy + corner * g.rect.zw;
  let m = g.xf0;
  let p = vec2f(m.x * lp.x + m.z * lp.y, m.y * lp.x + m.w * lp.y) +
    g.xf1.xy + g.offset.xy;
  var out : VOut;
  out.pos = to_clip(p, g.offset.z);
  out.em = vec2f(corner.x, 1.0 - corner.y);
  out.idx = ii;
  out.docp = p;
  return out;
}

fn bezier_x(q : Curve, t : f32) -> f32 {
  let mt = 1.0 - t;
  return mt * mt * q.p.x + 2.0 * mt * t * q.c.x + t * t * q.p.z;
}

fn dy_at(q : Curve, t : f32) -> f32 {
  let mt = 1.0 - t;
  return 2.0 * (mt * (q.c.y - q.p.y) + t * (q.p.w - q.c.y));
}

// Signed sub-pixel coverage of one crossing at parameter t with sign s: +/-1
// far to the right of the pixel, ramping through 0.5 as the crossing passes the
// pixel centre. invPx converts em-space x distance into pixels (1 / em/px).
fn crossing_at(p : vec2f, q : Curve, t : f32, s : f32, invPx : f32) -> f32 {
  let x = bezier_x(q, clamp(t, 0.0, 1.0));
  return s * clamp((x - p.x) * invPx + 0.5, 0.0, 1.0);
}

// Signed coverage from one curve's crossings of the horizontal ray at p.y.
//
// Robust at shared vertices: a 1-D quadratic Bezier stays within the range of
// its three y control points, so classifying by the strict sign (y > 0) of the
// endpoints tells the crossing count exactly. A vertex lying on the ray has
// y == 0, counted as "below" for BOTH curves that share it, so the crossing is
// attributed to exactly one of them — never doubled, never dropped, with no
// dependence on the root landing at t = 0 or 1.
fn ray_coverage(p : vec2f, q : Curve, invPx : f32) -> f32 {
  let y0 = q.p.y - p.y;
  let yc = q.c.y - p.y;
  let y1 = q.p.w - p.y;
  let a0 = y0 > 0.0;
  let a1 = y1 > 0.0;
  let ac = yc > 0.0;
  if (a0 == a1 && a1 == ac) { return 0.0; } // whole curve on one side

  let a = y0 - 2.0 * yc + y1;
  let b = y0 - yc;
  var t0 : f32;
  var t1 : f32;
  if (abs(a) < 1e-6) {
    let t = y0 / (2.0 * b);
    t0 = t;
    t1 = t;
  } else {
    let s = sqrt(max(b * b - a * y0, 0.0));
    t0 = (b - s) / a;
    t1 = (b + s) / a;
  }

  if (a0 != a1) {
    // Endpoints straddle the ray: exactly one crossing. Pick the in-range root
    // and take the sign from the endpoints (up if the curve ends above).
    let t = select(t1, t0, t0 >= 0.0 && t0 <= 1.0);
    let s = select(-1.0, 1.0, a1);
    return crossing_at(p, q, t, s, invPx);
  }

  // Endpoints on the same side but the control point is across: two crossings
  // (they cancel in winding, but both contribute sub-pixel edge coverage).
  var cov = 0.0;
  if (t0 >= 0.0 && t0 <= 1.0) {
    cov += crossing_at(p, q, t0, select(-1.0, 1.0, dy_at(q, t0) > 0.0), invPx);
  }
  if (t1 >= 0.0 && t1 <= 1.0) {
    cov += crossing_at(p, q, t1, select(-1.0, 1.0, dy_at(q, t1) > 0.0), invPx);
  }
  return cov;
}

// Summed signed coverage across the band containing em.y.
fn coverage_row(em : vec2f, gref : vec4u, invPx : f32) -> f32 {
  let bandCount = gref.y;
  let bi = clamp(u32(em.y * f32(bandCount)), 0u, bandCount - 1u);
  let band = bands[gref.x + bi];
  let start = u32(band.bounds.z);
  let end = u32(band.bounds.w);
  var cov = 0.0;
  for (var i = start; i < end; i = i + 1u) {
    cov = cov + ray_coverage(em, curves[i], invPx);
  }
  return cov;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  let g = glyphs[in.idx];
  if (g.gref.y == 0u) { discard; }
  let cl = g.clip;
  if (in.docp.x < cl.x || in.docp.y < cl.y ||
      in.docp.x > cl.z || in.docp.y > cl.w) { discard; }
  let invPx = 1.0 / max(fwidth(in.em.x), 1e-5);
  let pxH = max(fwidth(in.em.y), 1e-5);
  // 3-tap vertical supersample for anti-aliasing of near-horizontal edges.
  let ey = in.em.y;
  let c0 = abs(coverage_row(vec2f(in.em.x, ey - 0.36 * pxH), g.gref, invPx));
  let c1 = abs(coverage_row(vec2f(in.em.x, ey), g.gref, invPx));
  let c2 = abs(coverage_row(vec2f(in.em.x, ey + 0.36 * pxH), g.gref, invPx));
  let cov = clamp((c0 + c1 + c2) / 3.0, 0.0, 1.0);
  let a = cov * g.color.a;
  return vec4f(g.color.rgb * a, a);
}
`
