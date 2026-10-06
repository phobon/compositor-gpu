import { FRAME_WGSL } from '../../gpu/frame'
import {
  MAT_DEFAULT_WGSL,
  MAT_GRID_WGSL,
  MAT_IN_WGSL
} from '../../gpu/material'

/**
 * Slug fragment shader.
 *
 * Provenance: adapted from Eric Lengyel's Slug reference shaders, released to
 * the public domain (US patent 10,373,352 disclaimed March 2026; reference
 * code MIT). Per pixel we transform to em space and cast two rays, as
 * Slug does: a horizontal one through the row band holding em.y and a
 * vertical one through the column band holding em.x, each accumulating
 * signed sub-pixel analytic coverage from the quadratic curves it crosses
 * (the distance to each crossing, not a hard winding test), blended by
 * their weights so edges of every orientation anti-alias. Validated by the visual-regression harness (`npm run
 * test:visual`) plus offline WGSL validation with `naga`.
 *
 * Bind group 1:
 *   0 glyphs : per-instance {rect, offset, color, gref, clip, xf0, xf1}
 *   1 bands  : {min, max, curveStart, curveEnd}: a glyph's row bands,
 *              then its column bands (their curves x/y-swapped)
 *   2 curves : {p0.xy, p1.xy, c.xy} quadratic control points
 */

/** The instance, band and curve structs (GlyphTable's layout). */
export const SLUG_STRUCTS_WGSL = /* wgsl */ `
struct Glyph {
  rect   : vec4f,   // ink box x,y,w,h in the glyph's local line-box frame
  offset : vec4f,   // xy displacement, space (1 = viewport), _
  color  : vec4f,
  gref   : vec4u,   // bandStart, bandCount, index in material target, _
  clip   : vec4f,   // minX, minY, maxX, maxY (the record's space)
  xf0    : vec4f,   // a, b, c, d: linear part of local -> doc
  xf1    : vec4f,   // tx, ty (doc space), _, _
};
struct Band  { bounds : vec4f, };        // yMin, yMax, curveStart, curveEnd
struct Curve { p : vec4f, c : vec4f, };  // x0,y0,x1,y1 ; cx,cy,_,_
`

/**
 * Slug coverage: the curve maths of the fragment shader, shared with `/fx`
 * Layers that draw mirrored glyphs. Expects `Band`/`Curve` and storage
 * arrays named `bands` and `curves` in scope.
 */
export const SLUG_COVERAGE_WGSL = /* wgsl */ `
// Coverage curve: < 1 thickens edges, as browsers' text rasterisers do.
const SLUG_GAMMA : f32 = 0.87;
fn bezier_x(q : Curve, t : f32) -> f32 {
  let mt = 1.0 - t;
  return mt * mt * q.p.x + 2.0 * mt * t * q.c.x + t * t * q.p.z;
}

fn dy_at(q : Curve, t : f32) -> f32 {
  let mt = 1.0 - t;
  return 2.0 * (mt * (q.c.y - q.p.y) + t * (q.p.w - q.c.y));
}

// One crossing at parameter t with sign s: (signed coverage, weight).
// Coverage is +/-1 far to the right of the pixel, ramping through 0.5 as
// the crossing passes the pixel centre; the weight (Slug's) is 1 at the
// centre falling to 0 half a pixel away. invPx converts em-space distance
// along the ray into pixels.
fn crossing_at(p : vec2f, q : Curve, t : f32, s : f32, invPx : f32) -> vec2f {
  let d = (bezier_x(q, clamp(t, 0.0, 1.0)) - p.x) * invPx;
  return vec2f(s * clamp(d + 0.5, 0.0, 1.0), clamp(1.0 - abs(d) * 2.0, 0.0, 1.0));
}

// A root counts when it lies on the curve, within float error of an end
// (an endpoint on the ray: dropping it would leave a streak).
fn on_curve(t : f32) -> bool {
  return t >= -1e-4 && t <= 1.0 + 1e-4;
}

// One curve's crossings of the ray along +x at p.y: (summed signed
// coverage, max weight).
//
// Robust at shared vertices: a 1-D quadratic Bezier stays within the range of
// its three y control points, so classifying by the strict sign (y > 0) of the
// endpoints tells the crossing count exactly. A vertex lying on the ray has
// y == 0, counted as "below" for BOTH curves that share it, so the crossing is
// attributed to exactly one of them.
fn ray_coverage(p : vec2f, q : Curve, invPx : f32) -> vec2f {
  let y0 = q.p.y - p.y;
  let yc = q.c.y - p.y;
  let y1 = q.p.w - p.y;
  let a0 = y0 > 0.0;
  let a1 = y1 > 0.0;
  let ac = yc > 0.0;
  if (a0 == a1 && a1 == ac) { return vec2f(0.0); } // whole curve on one side

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
    let t = select(t1, t0, on_curve(t0));
    let s = select(-1.0, 1.0, a1);
    return crossing_at(p, q, t, s, invPx);
  }

  // Endpoints on the same side but the control point is across: two crossings
  // (they cancel in winding, but both contribute sub-pixel edge coverage).
  var r = vec2f(0.0);
  if (on_curve(t0)) {
    let c = crossing_at(p, q, t0, select(-1.0, 1.0, dy_at(q, t0) > 0.0), invPx);
    r = vec2f(r.x + c.x, max(r.y, c.y));
  }
  if (on_curve(t1)) {
    let c = crossing_at(p, q, t1, select(-1.0, 1.0, dy_at(q, t1) > 0.0), invPx);
    r = vec2f(r.x + c.x, max(r.y, c.y));
  }
  return r;
}

// The ray along +x at p.y through the band of \`count\` starting at \`base\`
// that holds p.y: (summed signed coverage, max weight).
fn band_coverage(p : vec2f, base : u32, count : u32, invPx : f32) -> vec2f {
  let bi = clamp(u32(p.y * f32(count)), 0u, count - 1u);
  let band = bands[base + bi];
  let start = u32(band.bounds.z);
  let end = u32(band.bounds.w);
  var r = vec2f(0.0);
  for (var i = start; i < end; i = i + 1u) {
    let c = ray_coverage(p, curves[i], invPx);
    r = vec2f(r.x + c.x, max(r.y, c.y));
  }
  return r;
}

// Slug's dual-ray coverage at em (0..1 in the ink box, y up): a horizontal
// ray through the row bands (gref.x, gref.y of them) and a vertical one
// through the column bands that follow (curves stored x/y-swapped), each
// exact across edges perpendicular to it, blended by their weights.
// inv: pixels per em unit along x and y.
fn slug_coverage(em : vec2f, gref : vec4u, inv : vec2f) -> f32 {
  // Two rays per direction, a quarter pixel either side of the centre
  // across the ray, so thin features and corners small text resolves
  // within a pixel still see both edges.
  let o = 0.25 / inv;
  let h0 = band_coverage(em - vec2f(0.0, o.y), gref.x, gref.y, inv.x);
  let h1 = band_coverage(em + vec2f(0.0, o.y), gref.x, gref.y, inv.x);
  let v0 = band_coverage((em - vec2f(o.x, 0.0)).yx, gref.x + gref.y, gref.y, inv.y);
  let v1 = band_coverage((em + vec2f(o.x, 0.0)).yx, gref.x + gref.y, gref.y, inv.y);
  let h = vec2f((abs(h0.x) + abs(h1.x)) * 0.5, max(h0.y, h1.y));
  let v = vec2f((abs(v0.x) + abs(v1.x)) * 0.5, max(v0.y, v1.y));
  let xc = h.x;
  let yc = v.x;
  let blend = (xc * h.y + yc * v.y) / max(h.y + v.y, 1.0 / 65536.0);
  let c = clamp(max(blend, min(xc, yc)), 0.0, 1.0);
  return select(0.0, pow(c, SLUG_GAMMA), c > 0.0);
}
`

/** The Slug shader with material hooks `mat` (gpu/material.ts) on a
 * `subdiv` × `subdiv` quad; SLUG_WGSL is the default variant. */
export const slugShader = (
  mat: string,
  subdiv: number,
  material: boolean
): string => /* wgsl */ `
${FRAME_WGSL}
${MAT_IN_WGSL}
${MAT_GRID_WGSL}
${mat}
const MAT_SUBDIV : u32 = ${subdiv}u;

${SLUG_STRUCTS_WGSL}
@group(1) @binding(0) var<storage, read> glyphs : array<Glyph>;
@group(1) @binding(1) var<storage, read> bands  : array<Band>;
@group(1) @binding(2) var<storage, read> curves : array<Curve>;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) em : vec2f,                 // 0..1 within the em box, y-up
  @location(1) @interpolate(flat) idx : u32,
  @location(2) docp : vec2f,
  @location(3) lp : vec2f,                 // line-box local (undisplaced)
};

@vertex
fn vs(@builtin(vertex_index) vi : u32,
      @builtin(instance_index) ii : u32) -> VOut {
  let g = glyphs[ii];
  let corner = mat_corner(vi, MAT_SUBDIV);
  let m = g.xf0;
  // The quad is the ink box grown by a device pixel per side, so the
  // anti-aliased fringe outside the outline (a stem at the box's edge,
  // as in l or i) is drawn rather than clipped. Local units per device
  // px along each axis, from the transform's column lengths.
  let sc = vec2f(length(m.xy), length(m.zw)) * frame.dpr;
  let pad = 1.0 / max(sc, vec2f(1e-3));
  let lp0 = g.rect.xy - pad + corner * (g.rect.zw + 2.0 * pad);
  // Hooks see the ink box (origin at its top-left), as MatIn.local does.
  // As a delta, so identity hooks leave lp0 bit-exact.
  let q = lp0 - g.rect.xy;
  let lp = lp0 + (mat_vertex(q, g.rect.zw, corner, ii) - q);
  let p = vec2f(m.x * lp.x + m.z * lp.y, m.y * lp.x + m.w * lp.y) +
    g.xf1.xy + g.offset.xy;
  var out : VOut;
  out.pos = to_clip(p, g.offset.z);
  let e = q / max(g.rect.zw, vec2f(1e-5));
  out.em = vec2f(e.x, 1.0 - e.y);
  out.idx = ii;
  out.docp = p;
  out.lp = lp0;
  return out;
}

${SLUG_COVERAGE_WGSL}
fn base_fs(in : VOut) -> vec4f {
  let g = glyphs[in.idx];
  if (g.gref.y == 0u) { discard; }
  let cl = g.clip;
  if (in.docp.x < cl.x || in.docp.y < cl.y ||
      in.docp.x > cl.z || in.docp.y > cl.w) { discard; }
  let inv = 1.0 / max(fwidth(in.em), vec2f(1e-5));
  let cov = slug_coverage(in.em, g.gref, inv);
  let a = cov * g.color.a;
  return vec4f(g.color.rgb * a, a);
}

${material ? MATERIAL_FS : DEFAULT_FS}
`

const DEFAULT_FS = /* wgsl */ `
@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  return base_fs(in);
}
`

const MATERIAL_FS = /* wgsl */ `
fn mat_sample(delta : vec2f) -> vec4f {
  return vec4f(0.0);
}
// The glyph's index in the material target's glyphs (target.glyphs).
fn mat_index(record : u32) -> u32 {
  return glyphs[record].gref.z;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  let c = base_fs(in);
  let g = glyphs[in.idx];
  let uv = vec2f(in.em.x, 1.0 - in.em.y);
  let cov = c.a / max(g.color.a, 1e-4);
  return mat_fragment(MatIn(c, in.lp - g.rect.xy, g.rect.zw, uv, in.docp,
    cov, 0.0, in.idx, 2u));
}
`

export const SLUG_WGSL = slugShader(MAT_DEFAULT_WGSL, 1, false)
