import { FRAME_WGSL, type RenderPass, type Shared } from '../gpu/frame'
import {
  quadVerts,
  SKELETON_WGSL,
  SkeletonTwin,
  skeletonFs
} from '../gpu/skeleton'
import { StorageArray } from '../gpu/storage'
import type { PathRecord } from '../scene/records'
import type { Scene } from '../scene/scene'
import { reportShaderErrors } from '../util/log'
import { PATH_WGSL } from './path_wgsl'

// The path pass (M5b): shapes of inline svgs drawn as vectors
// (PathRecords, dom/svg_paths.ts). One instance per record, a quad over
// its path-space bounds (grown by the stroke) mapped by its xform. The
// fragment fills by winding over the record's closed outline and strokes
// by distance to its centreline (paths/path_wgsl.ts), anti-aliased from
// the exact edge distance. Up to BRUTE_EDGES edges every pixel tests
// every edge; above that the record gets row bands built here, each
// listing the edges that reach its rows, so a pixel tests only its
// band's (static paths only: a morphing path over the limit is drawn
// rasterised by the reader).

/** Edges (fill + stroke) a record may have before it gets bands. */
export const BRUTE_EDGES = 256
/** Edges per band aimed for when banding. */
const EDGES_PER_BAND = 24
const MAX_BANDS = 128

const FLOATS_PER_PATH = 44 // 11 * vec4f
const FLOATS_PER_STROKE_EDGE = 8

const SHADER = /* wgsl */ `
${FRAME_WGSL}
${SKELETON_WGSL}
${skeletonFs('path')}
${PATH_WGSL}

struct Path {
  xf0    : vec4f,   // a, b, c, d: linear part of path space -> record space
  xf1    : vec4f,   // tx, ty, space (1 viewport), clip shape index
  box    : vec4f,   // quad bounds, path space: x0, y0, x1, y1
  fill   : vec4f,   // straight RGBA, a 0 = none
  stroke : vec4f,   // straight RGBA, a 0 = none
  style  : vec4f,   // half stroke width, miter limit, cap, join
  fills  : vec4f,   // first fill edge, fill edges, first stroke edge, stroke edges
  bands  : vec4f,   // first band, bands (0: none), first band y, bands per unit y
  clip   : vec4f,   // minX, minY, maxX, maxY (record space)
  flags  : vec4f,   // even-odd, 0, 0, 0
  _pad   : vec4f,
};
struct StrokeEdge {
  ab : vec4f,       // a, b
  pf : vec4f,       // previous point, flags (1 join at a, 2 cap at a, 4 cap at b), 0
};
@group(1) @binding(0) var<storage, read> paths : array<Path>;
@group(1) @binding(1) var<storage, read> fill_edges : array<vec4f>;
@group(1) @binding(2) var<storage, read> stroke_edges : array<StrokeEdge>;
// Per band: first fill index, fill indices, first stroke index, stroke
// indices (into band_idx).
@group(1) @binding(3) var<storage, read> bands : array<vec4f>;
// Edge numbers relative to the record's first fill / stroke edge.
@group(1) @binding(4) var<storage, read> band_idx : array<u32>;

struct VOut {
  @builtin(position) pos : vec4f,
  @location(0) local : vec2f,
  @location(1) @interpolate(flat) idx : u32,
  @location(2) docp : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32,
      @builtin(instance_index) ii : u32) -> VOut {
  var uv = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let r = paths[ii];
  let lp = mix(r.box.xy, r.box.zw, uv[skeleton_vi(vi)]);
  let m = r.xf0;
  let p = vec2f(m.x * lp.x + m.z * lp.y, m.y * lp.x + m.w * lp.y) + r.xf1.xy;
  var out : VOut;
  out.pos = to_clip(p, r.xf1.z);
  out.local = lp;
  out.idx = ii;
  out.docp = p;
  return out;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4f {
  let r = paths[in.idx];
  let p = in.local;
  // Path units per device pixel (derivatives first: uniform control flow).
  let apx = max(length(vec2f(length(dpdx(p)), length(dpdy(p)))) *
    0.70710678, 1e-6);
  let cl = r.clip;
  if (in.docp.x < cl.x || in.docp.y < cl.y ||
      in.docp.x > cl.z || in.docp.y > cl.w) {
    discard;
  }
  let f0 = u32(r.fills.x);
  let s0 = u32(r.fills.z);
  var fn_ = u32(r.fills.y);
  var sn = u32(r.fills.w);
  // Banded: this row's edges only, through band_idx.
  let banded = r.bands.y > 0.0;
  var fi = 0u;
  var si = 0u;
  if (banded) {
    let nb = u32(r.bands.y);
    let b = u32(clamp(floor((p.y - r.bands.z) * r.bands.w), 0.0,
      f32(nb - 1u)));
    let band = bands[u32(r.bands.x) + b];
    fi = u32(band.x);
    fn_ = u32(band.y);
    si = u32(band.z);
    sn = u32(band.w);
  }
  var fcov = 0.0;
  if (r.fill.a > 0.0) {
    var wind = 0;
    var acc = vec3f(1e20);
    for (var k = 0u; k < fn_; k++) {
      var e = k;
      if (banded) {
        e = band_idx[fi + k];
      }
      let ed = fill_edges[f0 + e];
      wind += path_wind(p, ed.xy, ed.zw);
      acc = path_fill_acc(acc, p, ed.xy, ed.zw);
    }
    let sd = path_fill_sd(wind, acc, r.flags.x > 0.5);
    fcov = clamp(sd / apx + 0.5, 0.0, 1.0);
  }
  var scov = 0.0;
  if (r.stroke.a > 0.0) {
    let h = r.style.x;
    let cap = u32(r.style.z);
    let join = u32(r.style.w);
    let overlap = min(1.5 * apx, h);
    var d = 1e20;
    for (var k = 0u; k < sn; k++) {
      var e = k;
      if (banded) {
        e = band_idx[si + k];
      }
      let se = stroke_edges[s0 + e];
      let fl = u32(se.pf.z);
      d = min(d, path_stroke_edge(p, se.ab.xy, se.ab.zw, h,
        (fl & 2u) != 0u, (fl & 4u) != 0u, cap,
        (fl & 1u) != 0u, se.pf.xy, join, r.style.y, overlap));
    }
    scov = clamp(0.5 - d / apx, 0.0, 1.0);
  }
  let fa = r.fill.a * fcov;
  let sa = r.stroke.a * scov;
  // Stroke over fill, premultiplied.
  let a = sa + fa * (1.0 - sa);
  let rgb = r.stroke.rgb * sa + r.fill.rgb * fa * (1.0 - sa);
  let k = frame_clip_cov(in.docp, r.xf1.w);
  return vec4f(rgb, a) * k;
}
`

/**
 * Draws PathRecords: fills by winding, strokes by distance, one quad per
 * record (see the file comment). Instance i is record i of
 * `scene.paths`.
 */
export class PathPass implements RenderPass {
  readonly layer = 'paths' as const
  private readonly pipeline: SkeletonTwin
  private readonly group1Layout: GPUBindGroupLayout
  private readonly paths: StorageArray
  private readonly fillEdges: StorageArray
  private readonly strokeEdges: StorageArray
  private readonly bands: StorageArray
  /** One u32 per item (read through `.u32`). */
  private readonly bandIdx: StorageArray
  private bindGroup: GPUBindGroup | null = null
  private count = 0

  constructor(private readonly shared: Shared) {
    const { device, format, frameLayout } = shared
    this.paths = new StorageArray(device, FLOATS_PER_PATH, 16, 'paths')
    this.fillEdges = new StorageArray(device, 4, 256, 'path fill edges')
    this.strokeEdges = new StorageArray(
      device,
      FLOATS_PER_STROKE_EDGE,
      256,
      'path stroke edges'
    )
    this.bands = new StorageArray(device, 4, 16, 'path bands')
    this.bandIdx = new StorageArray(device, 1, 256, 'path band edges')
    const storage = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: 'read-only-storage' }
    })
    this.group1Layout = device.createBindGroupLayout({
      entries: [0, 1, 2, 3, 4].map(storage)
    })
    const module = device.createShaderModule({ label: 'path', code: SHADER })
    reportShaderErrors(module, 'path')
    const over: GPUBlendComponent = {
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha'
    }
    this.pipeline = new SkeletonTwin(device, {
      label: 'path',
      layout: device.createPipelineLayout({
        bindGroupLayouts: [frameLayout, this.group1Layout]
      }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{ format, blend: { color: over, alpha: over } }]
      },
      primitive: { topology: 'triangle-list' }
    })
  }

  upload(scene: Scene): void {
    const recs = scene.paths
    this.count = recs.length
    if (this.count === 0) {
      return
    }
    // Sizes first, so every buffer is allocated once.
    let fills = 0
    let strokes = 0
    for (const r of recs) {
      const [f, s] = edgeTotals(r)
      fills += f
      strokes += s
    }
    let grew = this.paths.ensure(this.count)
    grew = this.fillEdges.ensure(Math.max(fills, 1)) || grew
    grew = this.strokeEdges.ensure(Math.max(strokes, 1)) || grew
    const fe = this.fillEdges.f32
    const se = this.strokeEdges.f32
    const pd = this.paths.f32
    const bandRows: number[] = []
    const idx: number[] = []
    const dpr = this.shared.dpr > 0 ? this.shared.dpr : 1
    let fo = 0
    let so = 0
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i] as PathRecord
      const f0 = fo
      const s0 = so
      if (r.fill) {
        fo = writeFillEdges(r, fe, fo)
      }
      if (r.stroke) {
        so = writeStrokeEdges(r, se, so)
      }
      const nf = fo - f0
      const ns = so - s0
      const h = r.stroke ? r.strokeWidth / 2 : 0
      const reach =
        h *
        Math.max(
          r.join === 0 ? r.miterLimit : 1,
          r.cap === 2 ? Math.SQRT2 : 1
        )
      // Two device px of anti-aliasing, in path units.
      const aa = 2 / (dpr * Math.max(scaleOf(r.xform), 1e-6))
      const [bx0, by0, bx1, by1] = r.bounds
      const x0 = bx0 - reach - aa
      const y0 = by0 - reach - aa
      const x1 = bx1 + reach + aa
      const y1 = by1 + reach + aa
      let bandFirst = 0
      let bandCount = 0
      let bandScale = 0
      if (nf + ns > BRUTE_EDGES) {
        bandFirst = bandRows.length / 4
        bandCount = Math.min(
          MAX_BANDS,
          Math.max(2, Math.ceil((nf + ns) / EDGES_PER_BAND))
        )
        bandScale = bandCount / Math.max(y1 - y0, 1e-6)
        buildBands(
          fe,
          f0,
          nf,
          se,
          s0,
          ns,
          y0,
          bandCount,
          1 / bandScale,
          reach + aa,
          aa,
          bandRows,
          idx
        )
      }
      const o = i * FLOATS_PER_PATH
      const xf = r.xform
      const cl = r.clip
      const rows = [
        xf[0],
        xf[1],
        xf[2],
        xf[3],
        xf[4],
        xf[5],
        r.space === 'viewport' ? 1 : 0,
        scene.clipIndex(r.clip),
        x0,
        y0,
        x1,
        y1,
        r.fill?.r ?? 0,
        r.fill?.g ?? 0,
        r.fill?.b ?? 0,
        r.fill?.a ?? 0,
        r.stroke?.r ?? 0,
        r.stroke?.g ?? 0,
        r.stroke?.b ?? 0,
        r.stroke?.a ?? 0,
        h,
        r.miterLimit,
        r.cap,
        r.join,
        f0,
        nf,
        s0,
        ns,
        bandFirst,
        bandCount,
        y0,
        bandScale,
        cl ? cl.x : -1e9,
        cl ? cl.y : -1e9,
        cl ? cl.x + cl.width : 1e9,
        cl ? cl.y + cl.height : 1e9,
        r.evenOdd ? 1 : 0,
        0,
        0,
        0,
        0,
        0,
        0,
        0
      ]
      pd.set(rows, o)
    }
    grew = this.bands.ensure(Math.max(bandRows.length / 4, 1)) || grew
    grew = this.bandIdx.ensure(Math.max(idx.length, 1)) || grew
    this.bands.f32.set(bandRows)
    this.bandIdx.u32.set(idx)
    if (grew || !this.bindGroup) {
      this.bindGroup = this.shared.device.createBindGroup({
        layout: this.group1Layout,
        entries: [
          this.paths,
          this.fillEdges,
          this.strokeEdges,
          this.bands,
          this.bandIdx
        ].map((a, binding) => ({
          binding,
          resource: { buffer: a.buffer as GPUBuffer }
        }))
      })
    }
    this.paths.write(0, this.count)
    this.fillEdges.write(0, fo)
    this.strokeEdges.write(0, so)
    this.bands.write(0, bandRows.length / 4)
    this.bandIdx.write(0, idx.length)
  }

  draw(encoder: GPURenderPassEncoder, first: number, count: number): number {
    if (count === 0 || !this.bindGroup) {
      return 0
    }
    const skeleton = this.shared.skeleton
    encoder.setPipeline(this.pipeline.get(skeleton))
    encoder.setBindGroup(1, this.bindGroup)
    encoder.draw(quadVerts(skeleton), count, 0, first)
    return 1
  }

  destroy(): void {
    this.paths.destroy()
    this.fillEdges.destroy()
    this.strokeEdges.destroy()
    this.bands.destroy()
    this.bandIdx.destroy()
  }
}

/** A record's fill edges (closed outlines) and stroke edges. */
function edgeTotals(r: PathRecord): [number, number] {
  let f = 0
  let s = 0
  for (let k = 0; k < r.contours.length; k += 3) {
    const n = r.contours[k + 1] ?? 0
    const closed = r.contours[k + 2] === 1
    if (r.fill) {
      f += n
    }
    if (r.stroke) {
      s += closed ? n : n - 1
    }
  }
  return [f, s]
}

/** Larger scale of an affine's linear part. */
function scaleOf(m: readonly number[]): number {
  const a = m[0] ?? 1
  const b = m[1] ?? 0
  const c = m[2] ?? 0
  const d = m[3] ?? 1
  const s1 = a * a + b * b + c * c + d * d
  const det = a * d - b * c
  return Math.sqrt((s1 + Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det))) / 2)
}

/** Every subpath closed (fill closes open ones): edge k joins point k to
 * point k + 1 (the last to the first). */
function writeFillEdges(r: PathRecord, out: Float32Array, at: number): number {
  const p = r.points
  let o = at
  for (let k = 0; k < r.contours.length; k += 3) {
    const first = r.contours[k] ?? 0
    const n = r.contours[k + 1] ?? 0
    for (let j = 0; j < n; j++) {
      const a = first + j
      const b = first + ((j + 1) % n)
      out.set(
        [p[a * 2] ?? 0, p[a * 2 + 1] ?? 0, p[b * 2] ?? 0, p[b * 2 + 1] ?? 0],
        o * 4
      )
      o++
    }
  }
  return o
}

/** The centreline: open subpaths keep their ends (caps), closed ones
 * join last to first; every edge but an open subpath's first carries its
 * previous point for the join at its start. */
function writeStrokeEdges(
  r: PathRecord,
  out: Float32Array,
  at: number
): number {
  const p = r.points
  let o = at
  for (let k = 0; k < r.contours.length; k += 3) {
    const first = r.contours[k] ?? 0
    const n = r.contours[k + 1] ?? 0
    const closed = r.contours[k + 2] === 1
    const edges = closed ? n : n - 1
    for (let j = 0; j < edges; j++) {
      const a = first + j
      const b = first + ((j + 1) % n)
      const prev = first + ((j - 1 + n) % n)
      let flags = 0
      if (closed || j > 0) {
        flags |= 1
      }
      if (!closed && j === 0) {
        flags |= 2
      }
      if (!closed && j === edges - 1) {
        flags |= 4
      }
      out.set(
        [
          p[a * 2] ?? 0,
          p[a * 2 + 1] ?? 0,
          p[b * 2] ?? 0,
          p[b * 2 + 1] ?? 0,
          p[prev * 2] ?? 0,
          p[prev * 2 + 1] ?? 0,
          flags,
          0
        ],
        o * FLOATS_PER_STROKE_EDGE
      )
      o++
    }
  }
  return o
}

/**
 * Row bands for a large static record: band b covers path y in
 * [y0 + b * h, y0 + (b + 1) * h]; it lists the fill edges whose y range
 * (grown by `fillPad`) and the stroke edges whose y range (grown by
 * `strokePad`, the stroke's reach) meet it. A fill ray along +x at y
 * crosses only edges spanning y, so the winding number from a band's
 * edges is exact; the nearest-edge distance only matters within the
 * anti-aliasing pad.
 */
function buildBands(
  fe: Float32Array,
  f0: number,
  nf: number,
  se: Float32Array,
  s0: number,
  ns: number,
  y0: number,
  count: number,
  h: number,
  strokePad: number,
  fillPad: number,
  rows: number[],
  idx: number[]
): void {
  const fill: number[][] = Array.from({ length: count }, () => [])
  const stroke: number[][] = Array.from({ length: count }, () => [])
  const add = (
    lists: number[][],
    e: number,
    ya: number,
    yb: number,
    pad: number
  ): void => {
    const lo = Math.max(0, Math.floor((Math.min(ya, yb) - pad - y0) / h))
    const hi = Math.min(
      count - 1,
      Math.floor((Math.max(ya, yb) + pad - y0) / h)
    )
    for (let b = lo; b <= hi; b++) {
      lists[b]?.push(e)
    }
  }
  for (let e = 0; e < nf; e++) {
    const o = (f0 + e) * 4
    add(fill, e, fe[o + 1] ?? 0, fe[o + 3] ?? 0, fillPad)
  }
  for (let e = 0; e < ns; e++) {
    const o = (s0 + e) * FLOATS_PER_STROKE_EDGE
    add(stroke, e, se[o + 1] ?? 0, se[o + 3] ?? 0, strokePad)
  }
  for (let b = 0; b < count; b++) {
    const f = fill[b] ?? []
    const s = stroke[b] ?? []
    rows.push(idx.length, f.length, idx.length + f.length, s.length)
    idx.push(...f, ...s)
  }
}
