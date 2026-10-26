// Polygon coverage in WGSL, shared by the path pass (paths/path_pass.ts)
// and anything else that fills or strokes flattened outlines (the morph
// engine's segments, M5d). Plain functions over points: the caller owns
// the edge loop and where its points come from.
//
// Fill: accumulate `path_wind` over the closed outline's edges (a ray
// along +x) and, per `path_cross_delta` class, the nearest edge distance
// (`path_seg_dist`); `path_fill_sd` keeps the edges that separate inside
// from outside (an outline crossing itself has edges inside the shape on
// both sides, which must not anti-alias) and signs the distance.
// Stroke: the union (min) of `path_stroke_edge` over the centreline's
// edges, each a butt-ended box plus its caps and the join at its start.
// Coverage of a signed distance d (> 0 inside), in units of `apx` (path
// units per device pixel): clamp(d / apx + 0.5, 0, 1).

export const PATH_WGSL = /* wgsl */ `
// Winding contribution of edge a -> b for a ray from p along +x.
fn path_wind(p : vec2f, a : vec2f, b : vec2f) -> i32 {
  let e = b - a;
  let side = e.x * (p.y - a.y) - e.y * (p.x - a.x);
  if (a.y <= p.y) {
    if (b.y > p.y && side > 0.0) {
      return 1;
    }
  } else if (b.y <= p.y && side < 0.0) {
    return -1;
  }
  return 0;
}

// Distance from p to segment a -> b.
fn path_seg_dist(p : vec2f, a : vec2f, b : vec2f) -> f32 {
  let e = b - a;
  let w = p - a;
  let t = clamp(dot(w, e) / max(dot(e, e), 1e-12), 0.0, 1.0);
  return length(w - e * t);
}

// How the winding number changes when p crosses edge a -> b: -1 from
// its right side (in y-down space) to its left, +1 the other way; 0 when
// p is past either end (always counted as a boundary). Horizontal edges
// included: the right side of an edge along +x is below it.
fn path_cross_delta(p : vec2f, a : vec2f, b : vec2f) -> i32 {
  let e = b - a;
  let w = p - a;
  let t = dot(w, e) / max(dot(e, e), 1e-12);
  if (t <= 0.0 || t >= 1.0) {
    return 0;
  }
  return select(1, -1, e.x * w.y - e.y * w.x > 0.0);
}

// Fill distances by crossing class: x any edge, y edges crossing to
// winding + 1, z edges crossing to winding - 1.
fn path_fill_acc(acc : vec3f, p : vec2f, a : vec2f, b : vec2f) -> vec3f {
  let d = path_seg_dist(p, a, b);
  let k = path_cross_delta(p, a, b);
  return vec3f(
    select(acc.x, min(acc.x, d), k == 0),
    select(acc.y, min(acc.y, d), k > 0),
    select(acc.z, min(acc.z, d), k < 0));
}

// Signed distance to the fill's boundary (> 0 inside) from the winding
// number and path_fill_acc's distances.
fn path_fill_sd(wind : i32, acc : vec3f, even_odd : bool) -> f32 {
  let inside = path_inside(wind, even_odd);
  var d = acc.x;
  if (inside != path_inside(wind + 1, even_odd)) {
    d = min(d, acc.y);
  }
  if (inside != path_inside(wind - 1, even_odd)) {
    d = min(d, acc.z);
  }
  return select(-d, d, inside);
}

// Is a winding number inside? even_odd: odd counts; else nonzero.
fn path_inside(wind : i32, even_odd : bool) -> bool {
  if (even_odd) {
    return (abs(wind) & 1) == 1;
  }
  return wind != 0;
}

// Signed distance to a convex or simple quad (a triangle repeats a
// vertex), negative inside.
fn path_sd_quad(p : vec2f, v0 : vec2f, v1 : vec2f, v2 : vec2f,
                v3 : vec2f) -> f32 {
  var v = array<vec2f, 4>(v0, v1, v2, v3);
  var d = dot(p - v0, p - v0);
  var s = 1.0;
  var j = 3u;
  for (var i = 0u; i < 4u; i++) {
    let e = v[j] - v[i];
    let w = p - v[i];
    let b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-12), 0.0, 1.0);
    d = min(d, dot(b, b));
    let c = vec3<bool>((p.y >= v[i].y), (p.y < v[j].y),
      (e.x * w.y > e.y * w.x));
    if (all(c) || all(!c)) {
      s = -s;
    }
    j = i;
  }
  return s * sqrt(d);
}

// Signed distance (negative inside) to the stroke of segment a -> b,
// half width h: the butt-ended box, extended by h at an end with a
// square cap (cap 2), a disc at an end with a round cap (cap 1); and at
// a, when has_join, the join with the previous segment pp -> a (join 0
// miter within miter_limit, else bevel; 1 round; 2 bevel). Where it
// joins the previous segment at a gentle turn (under 30 degrees) the box
// reaches back by overlap (about a device pixel): pieces of a union of
// distances that meet on a line leave it half covered, a seam, so
// neighbours overlap instead. Sharper joins are covered by the join
// piece, and overlapping there would poke past a bevel.
fn path_stroke_edge(p : vec2f, a : vec2f, b : vec2f, h : f32,
                    cap_a : bool, cap_b : bool, cap : u32,
                    has_join : bool, pp : vec2f, join : u32,
                    miter_limit : f32, overlap : f32) -> f32 {
  let e = b - a;
  let len = length(e);
  var d : f32;
  if (len < 1e-6) {
    d = length(p - a) - h;
  } else {
    let t = e / len;
    let n = vec2f(-t.y, t.x);
    let q = vec2f(dot(p - a, t), dot(p - a, n));
    var ea = select(0.0, h, cap_a && cap == 2u);
    let eb = select(0.0, h, cap_b && cap == 2u);
    let in_e0 = a - pp;
    let in_l0 = length(in_e0);
    if (has_join && in_l0 >= 1e-6) {
      let t0 = in_e0 / in_l0;
      if (dot(t0, t) > 0.866) {
        ea = overlap;
      }
    }
    let c = (len + eb - ea) * 0.5;
    let half = vec2f((len + ea + eb) * 0.5, h);
    let w = abs(vec2f(q.x - c, q.y)) - half;
    d = length(max(w, vec2f(0.0))) + min(max(w.x, w.y), 0.0);
  }
  if (cap == 1u) {
    if (cap_a) {
      d = min(d, length(p - a) - h);
    }
    if (cap_b) {
      d = min(d, length(p - b) - h);
    }
  }
  if (has_join && len >= 1e-6) {
    let in_e = a - pp;
    let in_len = length(in_e);
    if (in_len >= 1e-6) {
      if (join == 1u) {
        d = min(d, length(p - a) - h);
      } else {
        let t0 = in_e / in_len;
        let t1 = e / len;
        let cr = t0.x * t1.y - t0.y * t1.x;
        if (abs(cr) < 0.1 && dot(t0, t1) > 0.0) {
          // Nearly straight on (under ~6 degrees: a flattened curve): the
          // two butt ends meet on almost one line, which a union of
          // distances leaves half covered and a join piece would only be
          // a sliver over; a short box across the joint covers it (it
          // strays outside the true join by under 1% of the width).
          let q = vec2f(dot(p - a, t1), dot(p - a, vec2f(-t1.y, t1.x)));
          let w = abs(q) - vec2f(h * 0.25, h);
          d = min(d, length(max(w, vec2f(0.0))) + min(max(w.x, w.y), 0.0));
        } else {
          // The outer side: right of the turn when it turns left.
          let s = select(1.0, -1.0, cr > 0.0);
          let n0 = vec2f(-t0.y, t0.x) * s;
          let n1 = vec2f(-t1.y, t1.x) * s;
          let c0 = a + n0 * h;
          let c1 = a + n1 * h;
          let mid = n0 + n1;
          let ml = length(mid);
          // Outward along the bisector (forward for a hairpin).
          var m = t0;
          if (ml > 1e-6) {
            m = mid / ml;
          }
          var tip = c1;
          if (join == 0u && ml > 1e-6) {
            let cos_half = dot(m, n0);
            if (cos_half > 1e-6 && 1.0 / cos_half <= miter_limit) {
              tip = a + m * (h / cos_half);
            }
          }
          // The join's inner corner sits inside the turn, not at a: the
          // butt ends (a to c0, a to c1) then fall strictly inside the
          // join instead of on its edge, where they'd show as a seam.
          let a_in = a - m * (h * 0.5);
          d = min(d, path_sd_quad(p, a_in, c0, tip, c1));
        }
      }
    }
  }
  return d;
}
`
