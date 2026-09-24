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

fn winding_at(p : vec2f, q : Curve, t : f32) -> f32 {
  if (t < 0.0 || t > 1.0) { return 0.0; }
  let mt = 1.0 - t;
  let x = mt * mt * q.p.x + 2.0 * mt * t * q.c.x + t * t * q.p.z;
  if (x < p.x) { return 0.0; }
  let dy = 2.0 * (mt * (q.c.y - q.p.y) + t * (q.p.w - q.c.y));
  return select(-1.0, 1.0, dy > 0.0);
}

fn ray_quad(p : vec2f, q : Curve) -> f32 {
  let y0 = q.p.y - p.y;
  let yc = q.c.y - p.y;
  let y1 = q.p.w - p.y;
  let a = y0 - 2.0 * yc + y1;
  let b = y0 - yc;
  if (abs(a) < 1e-6) {
    // linear in t: y0 + t*(y1 - y0) = 0
    let t = y0 / (y0 - y1);
    return winding_at(p, q, t);
  }
  let d = b * b - a * y0;
  if (d < 0.0) { return 0.0; }
  let s = sqrt(d);
  return winding_at(p, q, (b - s) / a) + winding_at(p, q, (b + s) / a);
}

@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  let g = glyphs[in.idx];
  let bandCount = g.gref.y;
  if (bandCount == 0u) { discard; }
  let bi = clamp(u32(in.em.y * f32(bandCount)), 0u, bandCount - 1u);
  let band = bands[g.gref.x + bi];
  let start = u32(band.bounds.z);
  let end = u32(band.bounds.w);
  var winding = 0.0;
  for (var i = start; i < end; i = i + 1u) {
    winding += ray_quad(in.em, curves[i]);
  }
  let cov = clamp(abs(winding), 0.0, 1.0); // TODO analytic AA from reference
  let a = cov * g.color.a;
  return vec4f(g.color.rgb * a, a);
}
`
