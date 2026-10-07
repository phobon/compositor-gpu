import { shadowPad } from '../dom/styles'
import { FRAME_WGSL, type RenderPass, type Shared } from '../gpu/frame'
import {
  MAT_DEFAULT_WGSL,
  MAT_GRID_WGSL,
  MAT_IN_WGSL,
  type MaterialBinding,
  MaterialPipelines,
  PREMUL_BLEND
} from '../gpu/material'
import { SD_BOX_WGSL } from '../gpu/sdf'
import type { Scene } from '../scene/scene'
import { reportShaderErrors } from '../util/log'

const FLOATS_PER_BOX = 72 // 18 * vec4f
const BYTES_PER_BOX = FLOATS_PER_BOX * 4
const FLOATS_PER_STOP = 8 // [r,g,b,a] + [pos,0,0,0]
const BYTES_PER_STOP = FLOATS_PER_STOP * 4

/** The box shader with material hooks `mat` (gpu/material.ts) on a
 * `subdiv` × `subdiv` quad; the default variant has identity hooks. */
const shader = (
  mat: string,
  subdiv: number,
  wrap: string
): string => /* wgsl */ `
${FRAME_WGSL}
${MAT_IN_WGSL}
${MAT_GRID_WGSL}
${mat}
const MAT_SUBDIV : u32 = ${subdiv}u;

struct Box {
  xf0    : vec4f,   // a, b, c, d: linear part of local -> doc
  xf1    : vec4f,   // tx, ty (doc space), w, h (local size, CSS px)
  radius : vec4f,   // tl, tr, br, bl
  fill   : vec4f,   // sRGB rgba
  bc0    : vec4f,   // top border colour, sRGB rgba
  params : vec4f,   // border styles (base-4 t,r,b,l), opacity, z, space
  clip   : vec4f,   // minX, minY, maxX, maxY (the record's space)
  grad   : vec4f,   // kind (0 none, 1 linear, 2 radial, 3 conic;
                    // +8 repeating),
                    // angle, start, count
  gradc  : vec4f,   // radial: cx, cy (padding-box fractions), rx, ry (px)
  sh0    : vec4f,   // shadow: sigma, pad (local px), isShadow, inset;
                    // plain box: w = gradient tile repeats (1 x, 2 y)
  sh1    : vec4f,   // shadow: inner box x, y, w, h (local px) — the
                    // element box (outer) or the shadow box (inset);
                    // plain box: background-clip insets t, r, b, l
  shr    : vec4f,   // shadow: inner radii tl, tr, br, bl; plain box:
                    // dash path arc lengths tl, tr, br, bl
  bw     : vec4f,   // border widths top, right, bottom, left
  bc1    : vec4f,   // right border colour
  bc2    : vec4f,   // bottom border colour
  bc3    : vec4f,   // left border colour
  ry     : vec4f,   // vertical radii tl, tr, br, bl (= radius: circular)
  gt     : vec4f,   // gradient tile x, y (from the padding box), w, h;
                    // w = 0: the padding box. Shadows: inner vertical
                    // radii (with shr)
};
@group(1) @binding(0) var<storage, read> boxes : array<Box>;
// Two entries per stop: sRGB straight-alpha rgba, then (pos, 0, 0, 0).
@group(1) @binding(1) var<storage, read> stops : array<vec4f>;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) local : vec2f,
  @location(1) half  : vec2f,
  @location(2) @interpolate(flat) idx : u32,
  @location(3) docp : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32,
      @builtin(instance_index) ii : u32) -> VOut {
  let b = boxes[ii];
  let corner = mat_corner(vi, MAT_SUBDIV);
  let size = b.xf1.zw;
  let lp0 = corner * size;
  // Hooks see the element's box: a shadow's quad is padded by sh0.y.
  let pad = vec2f(b.sh0.y);
  let inner = max(size - 2.0 * pad, vec2f(1e-4));
  // As a delta, so identity hooks leave lp0 bit-exact.
  let q = lp0 - pad;
  let lp = lp0 + (mat_vertex(q, inner, q / inner, ii) - q);
  let m = b.xf0;
  let p = vec2f(m.x * lp.x + m.z * lp.y, m.y * lp.x + m.w * lp.y) + b.xf1.xy;
  var out : VOut;
  out.pos = to_clip(p, b.params.w);
  out.half = size * 0.5;
  // Centred local coords: the SDF and gradients run in the untransformed
  // box, and fwidth() picks up the transform's scale/rotation for AA.
  // Undisplaced, so a material's vertex hook warps the box with the quad.
  out.local = lp0 - size * 0.5;
  out.idx = ii;
  out.docp = p;
  return out;
}

// Signed distance to a rounded box with per-corner radius.
fn sd_round_box(p : vec2f, b : vec2f, r4 : vec4f) -> f32 {
  let top = select(r4.x, r4.y, p.x > 0.0);      // tl / tr
  let bot = select(r4.w, r4.z, p.x > 0.0);      // bl / br
  let r = select(top, bot, p.y > 0.0);
  let q = abs(p) - b + vec2f(r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2f(0.0))) - r;
}

${SD_BOX_WGSL}

// Coverage of a pixel by the inside (d < 0) of an edge; fw = pixel size.
fn edge_cov(d : f32, fw : f32) -> f32 {
  return clamp(0.5 - d / fw, 0.0, 1.0);
}

// erf approximation (Abramowitz & Stegun 7.1.27, max error 5e-4).
fn erf2(x : vec2f) -> vec2f {
  let s = sign(x);
  let a = abs(x);
  var t = 1.0 + (0.278393 + (0.230389 + 0.078108 * (a * a)) * a) * a;
  t = t * t;
  return s - s / (t * t);
}

fn gaussian(x : f32, sigma : f32) -> f32 {
  return exp(-(x * x) / (2.0 * sigma * sigma)) / (2.5066283 * sigma);
}

// Blurred coverage of one row (height offset y from the centre) of a
// rounded box, integrated exactly along x (Evan Wallace, "Fast Rounded
// Rectangle Shadows").
fn shadow_x(x : f32, y : f32, sigma : f32, corner : f32, cy : f32,
            h : vec2f) -> f32 {
  // Elliptical corners (cy != corner): the ellipse's half-width at y.
  let dy = min(h.y - cy - abs(y), 0.0);
  let ell = h.x - corner +
    corner * sqrt(max(0.0, 1.0 - (dy * dy) / max(cy * cy, 1e-8)));
  let delta = min(h.y - corner - abs(y), 0.0);
  let circ = h.x - corner + sqrt(max(0.0, corner * corner - delta * delta));
  let curved = select(ell, circ, corner == cy);
  let i = 0.5 + 0.5 * erf2((x + vec2f(-curved, curved)) * (0.70710678 / sigma));
  return i.y - i.x;
}

// Gaussian-blurred coverage of the rounded box (centre-relative p, half
// size h, per-corner radii r4) — numerical integration along y over +-3σ.
fn shadow_cov(p : vec2f, h : vec2f, r4 : vec4f, ry4 : vec4f,
              sigma : f32) -> f32 {
  let low = p.y - h.y;
  let high = p.y + h.y;
  let start = clamp(-3.0 * sigma, low, high);
  let end = clamp(3.0 * sigma, low, high);
  let n = 8.0;
  let st = (end - start) / n;
  var y = start + st * 0.5;
  var v = 0.0;
  for (var i = 0; i < 8; i = i + 1) {
    let row = p.y - y;
    let top = select(r4.x, r4.y, p.x > 0.0);
    let bot = select(r4.w, r4.z, p.x > 0.0);
    let circular = all(r4 == ry4);
    let rx = select(top, bot, row > 0.0);
    let corner = select(min(rx, h.x), min(rx, min(h.x, h.y)), circular);
    let ytop = select(ry4.x, ry4.y, p.x > 0.0);
    let ybot = select(ry4.w, ry4.z, p.x > 0.0);
    let cy = select(min(select(ytop, ybot, row > 0.0), h.y), corner,
                    circular);
    v = v + shadow_x(p.x, row, sigma, corner, cy, h) * gaussian(y, sigma) * st;
    y = y + st;
  }
  return v;
}

// Interpolate two sRGB straight-alpha stops in premultiplied sRGB (the CSS
// default), returning sRGB straight alpha.
fn mix_stops(c0 : vec4f, c1 : vec4f, f : f32) -> vec4f {
  let p0 = c0.rgb * c0.a;
  let p1 = c1.rgb * c1.a;
  let a = mix(c0.a, c1.a, f);
  let s = mix(p0, p1, f) / max(a, 1e-6);
  return vec4f(s, a);
}

// Colour at gradient-line position t. Stops are sorted by position (CSS
// fix-up); t outside [first, last] takes the end colour.
fn gradient_at(t : f32, start : u32, count : u32) -> vec4f {
  if (count == 0u) { return vec4f(0.0); }
  var c0 = stops[start * 2u];
  var p0 = stops[start * 2u + 1u].x;
  if (t <= p0) { return c0; }
  for (var i = 1u; i < count; i = i + 1u) {
    let c1 = stops[(start + i) * 2u];
    let p1 = stops[(start + i) * 2u + 1u].x;
    if (t <= p1) {
      let f = select(0.0, (t - p0) / (p1 - p0), p1 > p0);
      return mix_stops(c0, c1, f);
    }
    c0 = c1;
    p0 = p1;
  }
  return c0;
}

// A repeating gradient's t wrapped into [first stop, last stop).
fn repeat_t(t : f32, start : u32, count : u32) -> f32 {
  let p0 = stops[start * 2u + 1u].x;
  let period = stops[(start + count - 1u) * 2u + 1u].x - p0;
  if (period <= 1e-6) { return t; }
  let u = t - p0;
  return p0 + u - floor(u / period) * period;
}

// Blink's SelectBestDashGap (platform/graphics/styled_stroke_data.cc): the
// gap nearest g that fits a whole number of d-long dashes into len; an open
// path ends on a dash at both ends.
fn best_dash_gap(len : f32, d : f32, g : f32, closed : bool) -> f32 {
  let k = select(1.0, 0.0, closed);
  let n0 = floor((len + g * k) / (d + g));
  let n1 = n0 + 1.0;
  let g0 = (len - n0 * d) / max(n0 - k, 1.0);
  let g1 = (len - n1 * d) / max(n1 - k, 1.0);
  return select(g1, g0, g1 <= 0.0 || abs(g0 - g) < abs(g1 - g));
}

// Coverage of the pixel centred at x by the span [x0, x1]; a = pixel size.
fn span_cov(x : f32, x0 : f32, x1 : f32, a : f32) -> f32 {
  return clamp(min(x - x0, x1 - x) / a + 0.5, 0.0, 1.0);
}

// Blink's dash pattern at s along a stroked path of whole-px length len,
// after DashEffectFromStrokeStyle (platform/graphics/styled_stroke_data.cc):
// dashed is 3w on / 2w off under 3px and 2w / w from 3px, with the gap
// refitted; dotted up to 3px is w / w square dashes, not refitted; wider
// dots are round, diameter w, one centred at s = 0, spacing refitted.
// Paths no longer than two dashes are solid. dc: depth of the path in from
// the outer edge, depth: the pixel's.
fn dash_cov(style : u32, s : f32, len : f32, closed : bool, w : f32,
            depth : f32, dc : f32, a : f32) -> f32 {
  if (style == 2u && w > 3.0) {
    var period = 2.0 * w;
    if (len >= period) {
      period = best_dash_gap(len, w, w, closed) + w - 0.01;
    }
    let u = s - floor(s / period) * period;
    let c = vec2f(min(u, period - u), depth - dc);
    return clamp((w * 0.5 - length(c)) / a + 0.5, 0.0, 1.0);
  }
  let thin = w < 3.0;
  var d = w;
  var g = w;
  if (style == 1u) {
    d = select(2.0, 3.0, thin) * w;
    g = select(1.0, 2.0, thin) * w;
  }
  if (len <= 2.0 * d) { return 1.0; }
  let two = 2.0 * d + g + select(0.0, g, closed);
  if (len <= two) {
    d = d * len / two;
    g = g * len / two;
  } else if (style == 1u) {
    g = best_dash_gap(len, d, g, closed);
  }
  let period = d + g;
  let u = s - floor(s / period) * period;
  return span_cov(u, 0.0, d, a) + span_cov(u, period, period + d, a);
}

// Square dots (w <= 3) on a straight side, after Blink's
// EnforceDotsAtEndpoints (core/paint/box_border_painter.cc): a whole dot at
// each end, grown or with its gap moved by 1px, keyed on len mod 2w.
fn thin_dots_cov(x : f32, len : f32, w : f32, a : f32) -> f32 {
  if (len <= 3.0 * w) {
    return dash_cov(2u, x, len, false, w, 0.0, 0.0, a);
  }
  let n = i32(len);
  let wi = i32(w);
  let m4 = n % 4;
  let m6 = n % 6;
  var sd = false;
  var sg = 0.0;
  var so = 0.0;
  var ed = false;
  var eg = 0.0;
  if ((wi == 1 && n % 2 == 0) || (wi == 3 && m6 == 0)) {
    sd = true;
    sg = 1.0;
    so = 1.0;
  }
  if ((wi == 2 && m4 <= 1) || (wi == 3 && (m6 == 1 || m6 == 2))) {
    sd = true;
    so = -1.0;
  }
  if ((wi == 2 && m4 == 0) || (wi == 3 && m6 == 1)) { ed = true; }
  if ((wi == 2 && m4 == 3) || (wi == 3 && m6 >= 4)) {
    sd = true;
    so = 1.0;
  }
  if (wi == 3 && m6 == 5) {
    ed = true;
  } else if (wi == 3 && m6 == 0) {
    ed = true;
    eg = 1.0;
  }
  var p1 = 0.0;
  var p2 = len;
  var c = 0.0;
  if (sd) {
    c = span_cov(x, 0.0, w + sg, a);
    p1 = 2.0 * w + so;
  }
  if (ed) {
    c = max(c, span_cov(x, len - w - eg, len, a));
    p2 = len - (w + eg + 1.0);
  }
  let t = x - p1;
  let u = t - floor(t / (2.0 * w)) * 2.0 * w;
  let dots = span_cov(u, 0.0, w, a) + span_cov(u, 2.0 * w, 3.0 * w, a);
  return max(c, dots * span_cov(x, p1, p2, a));
}

// Dashed / dotted / double coverage at centred local p on side (0 top,
// 1 right, 2 bottom, 3 left) of width w; depth is px in from the outer
// edge. Blink (core/paint/box_border_painter.cc) strokes a box without
// radii one side at a time, each from outer corner to outer corner
// (PaintOneBorderSide -> DrawDashedOrDottedBoxSide), so the pattern is
// fitted per side and both sides' dashes cover each corner. A box with any
// radius is stroked as one closed path down the middle of the border
// (DrawCurvedDashedDottedBoxSide), clockwise from where the top edge leaves
// the top-left arc, fitted to the whole length; that path is inset by
// floor(w / 2) (CenterOutsets goes through FromInts). Dash ends are square
// to the path, so radial on the arcs. Double is two w/3 lines with a w/3
// gap.
fn border_style_cov(style : u32, p : vec2f, half : vec2f, r : vec4f,
                    arc : vec4f, bw : vec4f, side : u32, w : f32,
                    depth : f32, aa : f32, a : f32) -> f32 {
  if (style == 3u) {
    let t = depth / max(w, 1e-4);
    let inner = smoothstep(2.0 / 3.0 - aa / w, 2.0 / 3.0 + aa / w, t);
    let outer = 1.0 - smoothstep(1.0 / 3.0 - aa / w, 1.0 / 3.0 + aa / w, t);
    return max(inner, outer);
  }
  let wr = max(round(w), 1.0);
  if (all(r <= vec4f(0.0))) {
    let horiz = side == 0u || side == 2u;
    let len = round(select(2.0 * half.y, 2.0 * half.x, horiz));
    let x = select(p.y + half.y, p.x + half.x, horiz);
    if (style == 2u && wr <= 3.0) { return thin_dots_cov(x, len, wr, a); }
    // Round dots: the line is pulled in by w/2 at each end, the spacing
    // still fitted to the full length.
    let s = select(x, x - wr * 0.5, style == 2u);
    let c = dash_cov(style, s, len, false, wr, depth, wr * 0.5, a);
    if (style == 2u && len >= 2.0 * wr) {
      // Chrome paints each side's end dots, so a corner dot's coverage
      // mask is applied twice: its anti-aliased edge darkens to
      // 1 - (1 - c)^2 (a translucent colour's interior keeps its alpha).
      let period = best_dash_gap(len, wr, wr, false) + wr - 0.01;
      let corner = s < period * 0.5 || s > len - wr - period * 0.5;
      return select(c, 1.0 - (1.0 - c) * (1.0 - c), corner);
    }
    return c;
  }
  let ins = floor(bw * 0.5); // t, r, b, l
  let rc = max(r - vec4f(ins.w + ins.x, ins.x + ins.y, ins.y + ins.z,
                         ins.z + ins.w) * 0.5, vec4f(0.0));
  let lo = -half + vec2f(ins.w, ins.x);
  let hi = half - vec2f(ins.y, ins.z);
  // Centreline corner centres.
  let ctl = lo + vec2f(rc.x);
  let ctr = vec2f(hi.x - rc.y, lo.y + rc.y);
  let cbr = hi - vec2f(rc.z);
  let cbl = vec2f(lo.x + rc.w, hi.y - rc.w);
  // Segment starts: top, tr arc, right, br arc, bottom, bl arc, left, tl arc.
  // Arcs take Skia's measured length (arc, from upload), spread evenly
  // over the angle.
  let s1 = ctr.x - ctl.x;
  let s2 = s1 + arc.y;
  let s3 = s2 + cbr.y - ctr.y;
  let s4 = s3 + arc.z;
  let s5 = s4 + cbr.x - cbl.x;
  let s6 = s5 + arc.w;
  let s7 = s6 + cbl.y - ctl.y;
  let total = s7 + arc.x;
  let iq = 0.63661977; // 2 / pi
  var s = 0.0;
  if (p.x > ctr.x && p.y < ctr.y) {
    s = s1 + (atan2(p.y - ctr.y, p.x - ctr.x) * iq + 1.0) * arc.y;
  } else if (p.x > cbr.x && p.y > cbr.y) {
    s = s3 + atan2(p.y - cbr.y, p.x - cbr.x) * iq * arc.z;
  } else if (p.x < cbl.x && p.y > cbl.y) {
    s = s5 + (atan2(p.y - cbl.y, p.x - cbl.x) * iq - 1.0) * arc.w;
  } else if (p.x < ctl.x && p.y < ctl.y) {
    s = s7 + (atan2(p.y - ctl.y, p.x - ctl.x) * iq + 2.0) * arc.x;
  } else {
    switch (side) {
      case 0u: { s = p.x - ctl.x; }
      case 1u: { s = s2 + p.y - ctr.y; }
      case 2u: { s = s4 + cbr.x - p.x; }
      default: { s = s6 + cbl.y - p.y; }
    }
  }
  return dash_cov(style, s, floor(total), true, wr, depth,
                  floor(wr * 0.5), a);
}

fn base_fs(in : VOut) -> vec4f {
  let b = boxes[in.idx];
  let cl = b.clip;
  if (in.docp.x < cl.x || in.docp.y < cl.y ||
      in.docp.x > cl.z || in.docp.y > cl.w) { discard; }
  // Shadow records' quads are padded by sh0.y; pad = 0 for plain boxes.
  let d = sd_box(in.local, in.half - vec2f(b.sh0.y), b.radius, b.ry);
  let circular = all(b.radius == b.ry);
  let aa = max(fwidth(d), 1e-4);
  // Pixel size in local units, for the edge ramps: fwidth(d) doubles where
  // a pixel quad straddles a square corner's two SDF branches and blurs it.
  let apx = max(length(vec2f(length(dpdx(in.local)),
                             length(dpdy(in.local)))) * 0.70710678, 1e-4);
  let bw = b.bw; // top, right, bottom, left
  let opacity = b.params.y;

  // Derivatives must sit in uniform control flow: take the inner mask's
  // before branching.
  let ip = in.local + in.half - (b.sh1.xy + b.sh1.zw * 0.5);
  let di = sd_box(ip, b.sh1.zw * 0.5, b.shr, b.gt);
  let aai = max(fwidth(di), 1e-4);
  if (b.sh0.z > 0.5 && b.sh0.w > 0.5) {
    // Inset: the quad is the padding box (pad = 0), kept inside by the
    // outer mask; the shadow is everything outside the blurred shadow box.
    let sigma = b.sh0.x;
    var inner = 1.0 - smoothstep(-aai, aai, di);
    if (sigma > 0.05) {
      inner = shadow_cov(ip, b.sh1.zw * 0.5, b.shr, b.gt, sigma);
    }
    let keep = 1.0 - smoothstep(-aa, aa, d);
    let sa = b.fill.a * clamp(1.0 - inner, 0.0, 1.0) * keep;
    return vec4f(b.fill.rgb * sa, sa) * opacity;
  }
  if (b.sh0.z > 0.5) {
    let sigma = b.sh0.x;
    var cov = 1.0 - smoothstep(-aa, aa, d);
    if (sigma > 0.05) {
      cov = shadow_cov(in.local, in.half - vec2f(b.sh0.y), b.radius, b.ry,
                       sigma);
    }
    // Fully opaque from the border-box edge outward, so the element's own
    // AA edge pixel composites over full shadow (no background seam).
    let innerMask = smoothstep(-aai, aai, di + aai);
    let sa = b.fill.a * clamp(cov, 0.0, 1.0) * innerMask;
    return vec4f(b.fill.rgb * sa, sa) * opacity;
  }

  // Padding box: the border box inset per side, centre-relative.
  let half = in.half - vec2f(b.sh0.y);
  let ic = vec2f(bw.w - bw.y, bw.x - bw.z) * 0.5;
  let ih = max(half - vec2f(bw.w + bw.y, bw.x + bw.z) * 0.5, vec2f(0.0));
  // Inner radii (CSS: r minus the adjacent widths, a circular
  // approximation of the elliptical inner corner).
  var ir = max(b.radius - vec4f(max(bw.x, bw.w), max(bw.x, bw.y),
                                max(bw.z, bw.y), max(bw.z, bw.w)), vec4f(0.0));
  var iry = ir;
  if (!circular) {
    // Elliptical: each axis inset by its own side's width.
    ir = max(b.radius - bw.wyyw, vec4f(0.0));
    iry = max(b.ry - bw.xxzz, vec4f(0.0));
  }
  // Uniform widths: the outer SDF offset inward, as the ring always was.
  let uniform = all(bw.xxx == bw.yzw) && circular;
  let dIn = select(sd_box(in.local - ic, ih, ir, iry), d + bw.x, uniform);
  // Box-filter coverage (one pixel wide ramp): a snapped 1px ring covers
  // exactly one pixel row, as in Chrome.
  let outerCov = edge_cov(d, apx);
  let innerCov = edge_cov(dIn, apx);
  let borderCov = clamp(outerCov - innerCov, 0.0, 1.0);

  // Background painting area (background-clip): the border box inset by
  // sh1 per side. Zero insets (border-box) reuse the outer SDF, insets
  // equal to the widths (padding-box) the inner one.
  let ci = b.sh1;
  let fc = vec2f(ci.w - ci.y, ci.x - ci.z) * 0.5;
  let fh = max(half - vec2f(ci.w + ci.y, ci.x + ci.z) * 0.5, vec2f(0.0));
  var fr = max(b.radius - vec4f(max(ci.x, ci.w), max(ci.x, ci.y),
                                max(ci.z, ci.y), max(ci.z, ci.w)), vec4f(0.0));
  var fry = fr;
  if (!circular) {
    fr = max(b.radius - ci.wyyw, vec4f(0.0));
    fry = max(b.ry - ci.xxzz, vec4f(0.0));
  }
  var dF = sd_box(in.local - fc, fh, fr, fry);
  dF = select(dF, dIn, all(ci == bw));
  dF = select(dF, d, all(ci == vec4f(0.0)));
  let fillCov = edge_cov(dF, apx);

  // Border side: the smallest distance into the ring, normalised by that
  // side's width — the CSS mitre from the outer to the inner corner.
  // Zero-width sides never win.
  let dist = vec4f(in.local.y + half.y, half.x - in.local.x,
                   half.y - in.local.y, in.local.x + half.x);
  let nd = select(dist / max(bw, vec4f(1e-6)), vec4f(1e9), bw <= vec4f(0.0));
  var bc = b.bc0;
  var best = nd.x;
  var side = 0u;
  var sw = bw.x;
  if (nd.y < best) { bc = b.bc1; best = nd.y; side = 1u; sw = bw.y; }
  if (nd.z < best) { bc = b.bc2; best = nd.z; side = 2u; sw = bw.z; }
  if (nd.w < best) { bc = b.bc3; best = nd.w; side = 3u; sw = bw.w; }
  let style = (u32(b.params.x + 0.5) >> (2u * side)) & 3u;
  var pat = 1.0;
  if (style != 0u && borderCov > 0.0) {
    // Depth from the outer edge is -d: exact on the corner arcs too, where
    // the per-side distance would measure to the straight edge instead.
    pat = border_style_cov(style, in.local, half, b.radius, b.shr, bw,
                           side, sw, -d, aa, apx);
  }
  let bcov = borderCov * pat;
  // Coverage where the fill lies under a painted part of the border.
  let under = clamp(borderCov + fillCov - outerCov, 0.0, borderCov) * pat;

  // Background: gradient over fill, source-over, kept premultiplied.
  var bgp = b.fill.rgb * b.fill.a;
  var bga = b.fill.a;
  if (b.grad.x > 0.5) {
    // Gradient box = the tile (background-size/-position), else the
    // padding box; gp is centre-relative.
    var size = ih * 2.0;
    var gp = in.local - ic;
    if (b.gt.z > 0.0) {
      size = b.gt.zw;
      gp = in.local - ic + ih - b.gt.xy - size * 0.5;
    }
    let hs = size * 0.5;
    // Repeating axes wrap into the tile; the others mask outside it.
    let rm = u32(b.sh0.w + 0.5);
    let rep = vec2<bool>((rm & 1u) != 0u, (rm & 2u) != 0u);
    let q = gp + hs;
    let sz = max(size, vec2f(1e-4));
    gp = select(gp, q - floor(q / sz) * sz - hs, rep);
    let e = select(hs - abs(gp), vec2f(1e9), rep);
    let gm = clamp(min(e.x, e.y) / aa + 0.5, 0.0, 1.0);
    var t = 0.0;
    let repeating = b.grad.x > 8.5;
    let kind = select(b.grad.x, b.grad.x - 8.0, repeating);
    if (kind > 2.5) {
      // Conic: the angle about the centre, clockwise from up, past the from angle.
      let c = (b.gradc.xy - vec2f(0.5)) * size;
      let v = gp - c;
      let a = atan2(v.x, -v.y) - b.grad.y;
      t = fract(a * 0.15915494);
    } else if (kind < 1.5) {
      let ang = b.grad.y;
      let dir = vec2f(sin(ang), -cos(ang));
      let len = abs(size.x * sin(ang)) + abs(size.y * cos(ang));
      t = dot(gp, dir) / max(len, 1e-4) + 0.5;
    } else {
      let c = (b.gradc.xy - vec2f(0.5)) * size;
      t = length((gp - c) / max(b.gradc.zw, vec2f(1e-4)));
    }
    if (repeating) {
      t = repeat_t(t, u32(b.grad.z), u32(b.grad.w));
    }
    var g = gradient_at(t, u32(b.grad.z), u32(b.grad.w));
    g.a = g.a * gm;
    bgp = g.rgb * g.a + bgp * (1.0 - g.a);
    bga = g.a + bga * (1.0 - g.a);
  }

  // Premultiplied: border source-over the fill where they overlap.
  let bg = vec4f(bgp, bga);
  let bd = vec4f(bc.rgb * bc.a, bc.a);
  return (bd * bcov + bg * fillCov - bg * (bc.a * under)) * opacity;
}

${wrap}
`

const DEFAULT_FS = /* wgsl */ `
@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  return base_fs(in);
}
`

const MATERIAL_FS = /* wgsl */ `
// Boxes and images: the instance index (glyphs: the index in the target).
fn mat_index(record : u32) -> u32 {
  return record;
}
fn mat_sample(delta : vec2f) -> vec4f {
  return vec4f(0.0);
}

@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  let c = base_fs(in);
  let b = boxes[in.idx];
  let d = sd_box(in.local, in.half - vec2f(b.sh0.y), b.radius, b.ry);
  let apx = max(length(vec2f(length(dpdx(in.local)),
                             length(dpdy(in.local)))) * 0.70710678, 1e-4);
  // The element's box (a shadow's quad is padded by sh0.y).
  let pad = vec2f(b.sh0.y);
  let size = max(in.half * 2.0 - 2.0 * pad, vec2f(1e-4));
  let local = in.local + in.half - pad;
  return mat_fragment(MatIn(c, local, size, local / size, in.docp,
    edge_cov(d, apx), d, in.idx, 0u));
}
`

type Pt = [number, number]
const arcCache = new Map<number, number>()

/**
 * Length SkContourMeasure gives a quarter circle of radius r, the conic
 * Skia's addRRect emits (weight sqrt(1/2)): the chord sum after halving in
 * t while the curve midpoint sits more than 0.5px (larger axis) off the
 * chord (SkContourMeasure.cpp, conic_too_curvy / compute_conic_segs). Blink
 * fits and places the dashes of a rounded border by this length, which
 * runs about 0.1-0.3px short of the true arc per corner.
 */
function skQuarterArc(r: number): number {
  if (r <= 0) {
    return 0
  }
  const hit = arcCache.get(r)
  if (hit !== undefined) {
    return hit
  }
  const at = (t: number): Pt => {
    const a = (1 - t) * (1 - t)
    const b = 2 * Math.SQRT1_2 * t * (1 - t)
    const c = t * t
    const k = r / (a + b + c)
    return [(a + b) * k, (b + c) * k]
  }
  const seg = (t0: number, p0: Pt, t1: number, p1: Pt, n: number): number => {
    const th = (t0 + t1) / 2
    const ph = at(th)
    const dx = Math.abs(ph[0] - (p0[0] + p1[0]) / 2)
    const dy = Math.abs(ph[1] - (p0[1] + p1[1]) / 2)
    if (n < 16 && Math.max(dx, dy) > 0.5) {
      return seg(t0, p0, th, ph, n + 1) + seg(th, ph, t1, p1, n + 1)
    }
    return Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
  }
  const len = seg(0, at(0), 1, at(1), 0)
  if (arcCache.size > 256) {
    arcCache.clear()
  }
  arcCache.set(r, len)
  return len
}

/**
 * Instanced rounded-rect pass: one storage-buffer entry per box, one draw call.
 * The simplest full vertical slice of the DOM -> GPU sync loop.
 */
export class BoxPass implements RenderPass {
  readonly layer = 'boxes' as const
  private pipeline: GPURenderPipeline
  private readonly materials: MaterialPipelines
  private group1Layout: GPUBindGroupLayout
  private buffer: GPUBuffer | null = null
  private bindGroup: GPUBindGroup | null = null
  private capacity = 0
  private count = 0
  private data = new Float32Array(0)
  private stopBuffer: GPUBuffer | null = null
  private stopCapacity = 0
  private stopData = new Float32Array(0)

  constructor(private readonly shared: Shared) {
    const { device, format, frameLayout } = shared
    this.group1Layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' }
        }
      ]
    })
    const describe = (
      code: string,
      label: string,
      extra: GPUBindGroupLayout | null
    ): GPURenderPipelineDescriptor => {
      const module = device.createShaderModule({ label, code })
      reportShaderErrors(module, label)
      const layouts = [frameLayout, this.group1Layout]
      if (extra) {
        layouts.push(extra)
      }
      return {
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [{ format, blend: PREMUL_BLEND }]
        },
        primitive: { topology: 'triangle-list' }
      }
    }
    this.pipeline = device.createRenderPipeline(
      describe(shader(MAT_DEFAULT_WGSL, 1, DEFAULT_FS), 'box', null)
    )
    this.materials = new MaterialPipelines(
      'box',
      device,
      (code, n, label, layout, wrap) =>
        describe(wrap(shader(code, n, MATERIAL_FS)), label, layout)
    )
  }

  /** Grow the instance buffer; returns true when it was recreated. */
  private ensureCapacity(n: number): boolean {
    if (n <= this.capacity) {
      return false
    }
    const cap = Math.max(n, this.capacity ? this.capacity * 2 : 64)
    this.buffer?.destroy()
    this.buffer = this.shared.device.createBuffer({
      size: cap * BYTES_PER_BOX,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.data = new Float32Array(cap * FLOATS_PER_BOX)
    this.capacity = cap
    return true
  }

  /**
   * Grow the stop buffer; returns true when it was recreated. Always holds
   * at least one stop so the bind group is valid with no gradients.
   */
  private ensureStopCapacity(n: number): boolean {
    const need = Math.max(n, 1)
    if (need <= this.stopCapacity) {
      return false
    }
    const cap = Math.max(need, this.stopCapacity ? this.stopCapacity * 2 : 16)
    this.stopBuffer?.destroy()
    this.stopBuffer = this.shared.device.createBuffer({
      size: cap * BYTES_PER_STOP,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    this.stopData = new Float32Array(cap * FLOATS_PER_STOP)
    this.stopCapacity = cap
    return true
  }

  upload(scene: Scene): void {
    const boxes = scene.boxes
    this.count = boxes.length
    if (this.count === 0) {
      return
    }
    let stopCount = 0
    for (const b of boxes) {
      stopCount += b.gradient?.stops.length ?? 0
    }
    const grewBoxes = this.ensureCapacity(this.count)
    const grewStops = this.ensureStopCapacity(stopCount)
    if (grewBoxes || grewStops || !this.bindGroup) {
      this.bindGroup = this.shared.device.createBindGroup({
        layout: this.group1Layout,
        entries: [
          { binding: 0, resource: { buffer: this.buffer as GPUBuffer } },
          { binding: 1, resource: { buffer: this.stopBuffer as GPUBuffer } }
        ]
      })
    }
    const d = this.data
    const sd = this.stopData
    const dpr = this.shared.dpr > 0 ? this.shared.dpr : 1
    const snap = (v: number) => Math.round(v * dpr) / dpr
    // Chrome floors border widths to device px, keeping at least one.
    const snapW = (v: number) =>
      v > 0 ? Math.max(1, Math.floor(v * dpr + 1e-3)) / dpr : 0
    const keep = (v: number) => v
    let o = 0
    let so = 0
    for (const b of boxes) {
      const xf = b.xform
      const sh = b.shadow
      const bd = b.border
      // Untransformed boxes snap their edges to device pixels, as Chrome
      // does, so a 1px border lands on one pixel row instead of two.
      const flat =
        !sh && xf[0] === 1 && xf[1] === 0 && xf[2] === 0 && xf[3] === 1
      let tx = xf[4]
      let ty = xf[5]
      let w = b.local.w
      let h = b.local.h
      if (flat) {
        const x0 = snap(tx)
        const y0 = snap(ty)
        const min = (v: number) => (v > 0 ? 1 / dpr : 0)
        w = Math.max(snap(tx + w) - x0, min(w))
        h = Math.max(snap(ty + h) - y0, min(h))
        tx = x0
        ty = y0
      }
      const sw = flat ? snapW : keep
      d[o++] = xf[0]
      d[o++] = xf[1]
      d[o++] = xf[2]
      d[o++] = xf[3]
      d[o++] = tx
      d[o++] = ty
      d[o++] = w
      d[o++] = h
      d[o++] = b.radius[0]
      d[o++] = b.radius[1]
      d[o++] = b.radius[2]
      d[o++] = b.radius[3]
      d[o++] = b.fill.r
      d[o++] = b.fill.g
      d[o++] = b.fill.b
      d[o++] = b.fill.a
      const top = bd?.colors[0]
      d[o++] = top?.r ?? 0
      d[o++] = top?.g ?? 0
      d[o++] = top?.b ?? 0
      d[o++] = top?.a ?? 0
      d[o++] = bd
        ? bd.styles[0] +
          bd.styles[1] * 4 +
          bd.styles[2] * 16 +
          bd.styles[3] * 64
        : 0
      d[o++] = b.opacity
      d[o++] = b.z
      d[o++] = b.space === 'viewport' ? 1 : 0
      const c = b.clip
      d[o++] = c ? c.x : -1e9
      d[o++] = c ? c.y : -1e9
      d[o++] = c ? c.x + c.width : 1e9
      d[o++] = c ? c.y + c.height : 1e9
      const g = b.gradient
      if (g && g.stops.length >= 2) {
        d[o++] =
          (g.kind === 'linear' ? 1 : g.kind === 'radial' ? 2 : 3) +
          (g.repeating ? 8 : 0)
        d[o++] = g.angle
        d[o++] = so / FLOATS_PER_STOP
        d[o++] = g.stops.length
        d[o++] = g.center[0]
        d[o++] = g.center[1]
        d[o++] = g.radii[0]
        d[o++] = g.radii[1]
        for (const st of g.stops) {
          sd[so++] = st.color.r
          sd[so++] = st.color.g
          sd[so++] = st.color.b
          sd[so++] = st.color.a
          sd[so++] = st.pos
          sd[so++] = 0
          sd[so++] = 0
          sd[so++] = 0
        }
      } else {
        for (let k = 0; k < 8; k++) {
          d[o++] = 0
        }
      }
      if (sh) {
        d[o++] = sh.blur * 0.5
        d[o++] = sh.inset ? 0 : shadowPad(sh.blur)
        d[o++] = 1
        d[o++] = sh.inset ? 1 : 0
        d[o++] = sh.inner.x
        d[o++] = sh.inner.y
        d[o++] = sh.inner.w
        d[o++] = sh.inner.h
        d[o++] = sh.inner.radius[0]
        d[o++] = sh.inner.radius[1]
        d[o++] = sh.inner.radius[2]
        d[o++] = sh.inner.radius[3]
      } else {
        d[o++] = 0
        d[o++] = 0
        d[o++] = 0
        d[o++] = (g?.repeat?.[0] ? 1 : 0) + (g?.repeat?.[1] ? 2 : 0)
        const bi = b.bgInset
        for (let k = 0; k < 4; k++) {
          d[o++] = bi ? sw(bi[k] ?? 0) : 0
        }
        // Dashed/dotted rounded borders: Skia's measured length of each
        // corner's centreline arc (see border_style_cov).
        const dashy = bd?.styles.some((s) => s === 1 || s === 2) ?? false
        const ins = (k: number) => Math.floor(sw(bd?.widths[k] ?? 0) / 2) / 2
        for (let k = 0; k < 4; k++) {
          // Corners tl, tr, br, bl; sides top, right, bottom, left.
          const side = k === 0 || k === 1 ? 0 : 2
          const other = k === 0 || k === 3 ? 3 : 1
          const r = (b.radius[k] ?? 0) - ins(side) - ins(other)
          d[o++] = dashy ? skQuarterArc(Math.max(r, 0)) : 0
        }
      }
      // Shadow records ignore `border`: zero widths keep the ring empty.
      for (let k = 0; k < 4; k++) {
        d[o++] = sh || !bd ? 0 : sw(bd.widths[k] ?? 0)
      }
      for (let k = 1; k < 4; k++) {
        const c = bd?.colors[k]
        d[o++] = c?.r ?? 0
        d[o++] = c?.g ?? 0
        d[o++] = c?.b ?? 0
        d[o++] = c?.a ?? 0
      }
      const ry = b.radiusY
      for (let k = 0; k < 4; k++) {
        d[o++] = ry ? (ry[k] ?? 0) : (b.radius[k] ?? 0)
      }
      // Shadows: the inner box's vertical radii; boxes: the gradient tile.
      const gt = sh ? (sh.inner.radiusY ?? sh.inner.radius) : b.gradient?.tile
      for (let k = 0; k < 4; k++) {
        d[o++] = gt ? (gt[k] ?? 0) : 0
      }
    }
    this.shared.device.queue.writeBuffer(
      this.buffer as GPUBuffer,
      0,
      d,
      0,
      this.count * FLOATS_PER_BOX
    )
    if (so > 0) {
      this.shared.device.queue.writeBuffer(
        this.stopBuffer as GPUBuffer,
        0,
        sd,
        0,
        so
      )
    }
  }

  draw(
    encoder: GPURenderPassEncoder,
    first: number,
    count: number,
    material?: MaterialBinding | null
  ): number {
    if (count === 0 || !this.bindGroup) {
      return 0
    }
    const mp = this.materials.get(material)
    if (!mp && this.materials.held(material)) {
      return 0
    }
    encoder.setPipeline(mp ?? this.pipeline)
    encoder.setBindGroup(1, this.bindGroup)
    let verts = 6
    if (mp && material) {
      encoder.setBindGroup(2, material.bindGroup)
      const n = Math.max(1, Math.floor(material.subdivisions))
      verts = 6 * n * n
    }
    encoder.draw(verts, count, 0, first)
    return 1
  }

  dropMaterial(id: number): void {
    this.materials.drop(id)
  }

  destroy(): void {
    this.buffer?.destroy()
    this.stopBuffer?.destroy()
  }
}
