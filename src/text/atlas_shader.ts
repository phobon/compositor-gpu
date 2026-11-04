import { resolveShader } from '../gpu/frame'
import { SKELETON_WGSL, skeletonFs } from '../gpu/skeleton'
import { ATLAS_EXTERNALS } from './glyph_data'

/**
 * Textured quads for fallback glyphs sampled from the Canvas 2D glyph atlas
 * (see glyphAtlas.ts). The atlas texture is premultiplied. Mono glyphs are
 * white coverage tinted by `color`; colour glyphs keep their own RGB and only
 * take `color.a` (glyph alpha × run opacity).
 *
 * Bind group 1 is `atlasLayout` (glyph_data.ts).
 */
export const ATLAS_WGSL: string = resolveShader(
  /* wgsl */ `
${SKELETON_WGSL}
${skeletonFs('fallback')}

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
  let corner = quad[skeleton_vi(vi)];
  let lp = q.rect.xy + corner * q.rect.zw;
  let m = q.xf0;
  let p = vec2f(m.x * lp.x + m.z * lp.y, m.y * lp.x + m.w * lp.y) + q.xf1.xy;
  var out : VOut;
  out.pos = to_clip(p, q.params.y);
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
  let k = frame_clip_cov(in.docp, q.params.z);
  let a = t.a * q.color.a * k;
  if (q.params.x > 0.5) {
    return vec4f(q.color.rgb * a, a);   // mono: alpha is coverage
  }
  return vec4f(t.rgb * q.color.a * k, a);   // colour: already premultiplied
}
`,
  ATLAS_EXTERNALS
)
