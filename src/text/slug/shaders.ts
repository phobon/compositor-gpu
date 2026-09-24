import { FRAME_WGSL } from '../../gpu/frame'

/**
 * Slug fragment shader (SCAFFOLD).
 *
 * Provenance: adapted from Eric Lengyel's Slug reference shaders, released to
 * the public domain (US patent 10,373,352 disclaimed March 2026; reference
 * code MIT). This is a STRUCTURAL port: per pixel we transform to em space,
 * pick the band by em.y, and accumulate a winding number from the quadratic
 * curves crossing the pixel's scanline to the right. The reference's analytic
 * sub-pixel coverage and robust root handling must be finished and validated
 * in a real browser (WebGPU can't run in the build sandbox), so v1 uses a
 * nonzero-winding hard coverage as a placeholder.
 *
 * Bind group 1:
 *   0 glyphs : per-instance {rect, offset, color, gref}
 *   1 bands  : {yMin, yMax, curveStart, curveEnd} per glyph-band
 *   2 curves : {p0.xy, p1.xy, c.xy} quadratic control points
 */
export const SLUG_WGSL = /* wgsl */ `
${FRAME_WGSL}

struct Glyph {
  rect   : vec4f,   // x,y,w,h document space
  offset : vec4f,   // xy displacement, z, _
  color  : vec4f,
  gref   : vec4u,   // bandStart, bandCount, _, _
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
};

@vertex
fn vs(@builtin(vertex_index) vi : u32,
      @builtin(instance_index) ii : u32) -> VOut {
  var uv = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let g = glyphs[ii];
  let corner = uv[vi];
  let p = g.rect.xy + g.offset.xy + corner * g.rect.zw;
  var out : VOut;
  out.pos = doc_to_clip(p);
  out.em = vec2f(corner.x, 1.0 - corner.y);
  out.idx = ii;
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

// Signed sub-pixel coverage of one crossing: +/-1 far to the right of the
// pixel, ramping through 0.5 as the crossing passes the pixel centre. invPx
// converts em-space x distance into pixels (1 / em-per-pixel).
fn crossing_cov(p : vec2f, q : Curve, t : f32, invPx : f32) -> f32 {
  if (t < 0.0 || t > 1.0) { return 0.0; }
  let x = bezier_x(q, t);
  let s = select(-1.0, 1.0, dy_at(q, t) > 0.0);
  return s * clamp((x - p.x) * invPx + 0.5, 0.0, 1.0);
}

// Signed coverage contributed by a curve's crossings of the ray at p.y.
fn ray_coverage(p : vec2f, q : Curve, invPx : f32) -> f32 {
  let y0 = q.p.y - p.y;
  let yc = q.c.y - p.y;
  let y1 = q.p.w - p.y;
  let a = y0 - 2.0 * yc + y1;
  let b = y0 - yc;
  if (abs(a) < 1e-6) {
    return crossing_cov(p, q, y0 / (y0 - y1), invPx);
  }
  let d = b * b - a * y0;
  if (d < 0.0) { return 0.0; }
  let s = sqrt(d);
  return crossing_cov(p, q, (b - s) / a, invPx)
       + crossing_cov(p, q, (b + s) / a, invPx);
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
  let invPx = 1.0 / max(fwidth(in.em.x), 1e-5);
  let pxH = max(fwidth(in.em.y), 1e-5);
  // 3-tap vertical supersample for anti-aliasing of near-horizontal edges.
  let c0 = abs(coverage_row(vec2f(in.em.x, in.em.y - 0.36 * pxH), g.gref, invPx));
  let c1 = abs(coverage_row(in.em, g.gref, invPx));
  let c2 = abs(coverage_row(vec2f(in.em.x, in.em.y + 0.36 * pxH), g.gref, invPx));
  let cov = clamp((c0 + c1 + c2) / 3.0, 0.0, 1.0);
  let a = cov * g.color.a;
  return vec4f(g.color.rgb * a, a);
`
