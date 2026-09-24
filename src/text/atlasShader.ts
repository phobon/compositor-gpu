import { FRAME_WGSL } from '../gpu/frame'

/** Floats per atlas quad: rect(4) + uv(4) + color(4) + params(4) + clip(4). */
export const ATLAS_QUAD_FLOATS = 20

/**
 * Textured quads for fallback glyphs sampled from the Canvas 2D glyph atlas
 * (see glyphAtlas.ts). The atlas texture is premultiplied. Mono glyphs are
 * white coverage tinted by `color`; colour glyphs keep their own RGB and only
 * take `color.a` (glyph alpha × run opacity).
 *
 * Bind group 1:
 *   0 quads   : per-instance Quad, aligned with scene glyph order
 *   1 tex     : atlas texture (rgba8unorm, premultiplied)
 *   2 samp    : linear / clamp
 */
export const ATLAS_WGSL = /* wgsl */ `
${FRAME_WGSL}

struct Quad {
  rect   : vec4f,   // x,y,w,h document space (offset already applied)
  uv     : vec4f,   // u0,v0,u1,v1
  color  : vec4f,   // sRGB straight alpha; a = glyph alpha * run opacity
  params : vec4f,   // tint (1 = mono coverage), _, _, _
  clip   : vec4f,   // minX, minY, maxX, maxY (doc space)
};
@group(1) @binding(0) var<storage, read> quads : array<Quad>;
@group(1) @binding(1) var tex  : texture_2d<f32>;
@group(1) @binding(2) var samp : sampler;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
  @location(1) @interpolate(flat) idx : u32,
  @location(2) docp : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32,
      @builtin(instance_index) ii : u32) -> VOut {
  var quad = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let q = quads[ii];
  let corner = quad[vi];
  let p = q.rect.xy + corner * q.rect.zw;
  var out : VOut;
  out.pos = doc_to_clip(p);
  out.uv = mix(q.uv.xy, q.uv.zw, corner);
  out.idx = ii;
  out.docp = p;
  return out;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  let t = textureSample(tex, samp, in.uv);
  let q = quads[in.idx];
  let cl = q.clip;
  if (in.docp.x < cl.x || in.docp.y < cl.y ||
      in.docp.x > cl.z || in.docp.y > cl.w) { discard; }
  let a = t.a * q.color.a;
  if (q.params.x > 0.5) {
    return vec4f(q.color.rgb * a, a);   // mono: alpha is coverage
  }
  return vec4f(t.rgb * q.color.a, a);   // colour: already premultiplied
}
`
