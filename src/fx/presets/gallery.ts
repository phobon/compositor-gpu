import type { Effects } from '../effects'
import type { Layer } from '../layer'
import type { Target } from '../target'

// A 3D carousel of the given elements' images: one plane per image on a
// ring of `radius` CSS px, seen in perspective (`fov` degrees, from
// `distance` px in front of the ring's centre, tilted `tilt` degrees
// about the horizontal), turned `rotation` degrees and spinning at
// `speed` degrees a second, centred on the viewport plus `offset`.
// Planes are `width` px wide with the image's aspect (cover-fitted,
// `corner` px rounded), shaded toward `far` at the back, drawn back to
// front over everything (viewport space) at `opacity`, with an optional
// `backdrop` colour filling the viewport behind them. The projection is
// computed on the CPU each frame (a handful of planes); the fragment
// divides by the interpolated 1/z, so textures are perspective-correct.

const VERTEX = /* wgsl */ `
fn vertex(i : u32, corner : vec2f) -> Quad {
  let c = u32(corner.x + 0.5) + 2u * u32(corner.y + 0.5);
  let q = data(i, c * 3u + 2u);
  var o : Quad;
  o.pos = vec2f(data(i, c * 3u), data(i, c * 3u + 1u));
  o.uv = corner;
  o.color = vec4f(data(i, 12u), data(i, 13u), data(i, 14u), data(i, 15u));
  o.extra = vec4f(corner * q, q, 0.0);
  return o;
}
`

const FRAGMENT = /* wgsl */ `
fn gal_box(p : vec2f, b : vec2f, r : f32) -> f32 {
  let q = abs(p) - b + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

fn fragment(q : Quad, i : u32) -> vec4f {
  let uv = q.extra.xy / q.extra.z;
  let back = q.color.x < 0.0;
  let k = u32(max(q.color.x, 0.0) + 0.5);
  let shade = q.color.y;
  let aspect = max(q.color.z, 1e-3);
  // Cover-fit the image into the plane.
  let isz = image_size_at(k);
  let ia = select(aspect, isz.x / max(isz.y, 1.0), isz.x > 0.0);
  let sx = select(1.0, aspect / ia, ia > aspect);
  let sy = select(ia / aspect, 1.0, ia > aspect);
  let t = vec2f(0.5) + (uv - vec2f(0.5)) * vec2f(sx, sy);
  let c = image_at(k, t);
  // Rounded edge, anti-aliased in screen space.
  let size = vec2f(params.width, params.width / aspect);
  let d = gal_box(uv * size - size * 0.5, size * 0.5,
    min(params.corner, min(size.x, size.y) * 0.5));
  let cov = clamp(0.5 - d / max(fwidth(d), 1e-4), 0.0, 1.0);
  let plane = vec4f(c.rgb * shade, c.a) * cov;
  let bg = vec4f(params.backdrop.rgb * params.backdrop.a, params.backdrop.a);
  return select(plane, bg, back) * params.opacity;
}
`

const schema = {
  rotation: { type: 'f32', default: 0, min: -360, max: 360 },
  speed: { type: 'f32', default: 12, min: -180, max: 180 },
  radius: { type: 'f32', default: 420, min: 0, max: 2000 },
  width: { type: 'f32', default: 220, min: 10, max: 1200 },
  tilt: { type: 'f32', default: 12, min: -80, max: 80 },
  fov: { type: 'f32', default: 50, min: 10, max: 120 },
  distance: { type: 'f32', default: 1200, min: 100, max: 6000 },
  far: { type: 'f32', default: 0.45, min: 0, max: 1 },
  corner: { type: 'f32', default: 10, min: 0, max: 200 },
  opacity: { type: 'f32', default: 1, min: 0, max: 1 },
  offset: { type: 'vec2', default: [0, 0] },
  backdrop: { type: 'color', default: '#00000000' }
} as const

export type GallerySchema = typeof schema

export interface GalleryOptions {
  /** The elements whose images become planes, in ring order. */
  images: readonly (Target | Element)[]
  /** Fallback plane aspect (w / h) until an image's size is known.
   * Default 0.75. */
  aspect?: number
  /** Texture slice size per image, texels. Default 512. */
  imageSize?: number
  /** Backdrop colour behind the planes (default none). */
  backdrop?: string | number[]
  rotation?: number
  speed?: number
  radius?: number
  width?: number
  tilt?: number
  fov?: number
  distance?: number
  far?: number
  corner?: number
  opacity?: number
  /** Default true. */
  enabled?: boolean
  name?: string
}

const STRIDE = 16
const RAD = Math.PI / 180

export function gallery(
  fx: Effects,
  opts: GalleryOptions
): Layer<GallerySchema> {
  const targets = opts.images.map((x) =>
    x instanceof Element ? fx.target(x) : x
  )
  const n = targets.length
  const fallback = opts.aspect ?? 0.75
  // Per plane: centre depth and projected corners, for sorting.
  const planes = targets.map((t, k) => ({
    k,
    t,
    z: 0,
    v: new Float32Array(16)
  }))
  let lastTime: number | null = null
  let turned = 0
  const layer = fx.layer({
    name: opts.name ?? 'gallery',
    count: n + 1,
    stride: STRIDE,
    space: 'viewport',
    place: 'above',
    images: targets,
    imageSize: opts.imageSize,
    params: schema,
    vertex: VERTEX,
    fragment: FRAGMENT,
    enabled: opts.enabled,
    continuous: (opts.speed ?? schema.speed.default) !== 0,
    update(l, time, ctx) {
      const p = l.params
      const dt = lastTime === null ? 0 : Math.min(time - lastTime, 1 / 15)
      lastTime = time
      if (!fx.reducedMotion) {
        turned += p.speed * dt
      }
      l.continuous = p.speed !== 0
      const vw = ctx.width
      const vh = ctx.height
      const cx = vw / 2 + (p.offset[0] ?? 0)
      const cy = vh / 2 + (p.offset[1] ?? 0)
      const f = vh / 2 / Math.tan((p.fov * RAD) / 2)
      const ct = Math.cos(p.tilt * RAD)
      const st = Math.sin(p.tilt * RAD)
      const D = p.distance
      for (const pl of planes) {
        const img = pl.t.image
        const aspect = img && img.height > 0 ? img.width / img.height : fallback
        const w = p.width
        const h = w / aspect
        const a = (p.rotation + turned) * RAD + (2 * Math.PI * pl.k) / n
        const ca = Math.cos(a)
        const sa = Math.sin(a)
        let zsum = 0
        for (let c = 0; c < 4; c++) {
          const x = ((c & 1) - 0.5) * w
          const y = ((c >> 1) - 0.5) * h
          // Around the ring (about y), then tilted (about x); y is down.
          const rx = x * ca - p.radius * sa
          const rz = -x * sa - p.radius * ca
          const ty = y * ct - rz * st
          const tz = y * st + rz * ct
          const z = Math.max(D + tz, 1)
          pl.v[c * 3] = cx + (f * rx) / z
          pl.v[c * 3 + 1] = cy + (f * ty) / z
          pl.v[c * 3 + 2] = D / z
          zsum += z
        }
        pl.z = zsum / 4
        // Depth 0 at the front of the ring, 1 at the back.
        const back = Math.min(
          Math.max((pl.z - (D - p.radius)) / (2 * p.radius || 1), 0),
          1
        )
        pl.v[12] = pl.k
        pl.v[13] = 1 - back * (1 - p.far)
        pl.v[14] = aspect
        pl.v[15] = 0
      }
      planes.sort((x, y) => y.z - x.z)
      const d = l.data
      // Instance 0: the backdrop, the whole viewport.
      d.fill(0, 0, STRIDE)
      const corners = [0, 0, vw, 0, 0, vh, vw, vh]
      for (let c = 0; c < 4; c++) {
        d[c * 3] = corners[c * 2] ?? 0
        d[c * 3 + 1] = corners[c * 2 + 1] ?? 0
        d[c * 3 + 2] = 1
      }
      d[12] = -1
      planes.forEach((pl, j) => {
        d.set(pl.v, (j + 1) * STRIDE)
      })
      l.markDirty()
    }
  })
  const p = layer.params
  for (const k of [
    'rotation',
    'speed',
    'radius',
    'width',
    'tilt',
    'fov',
    'distance',
    'far',
    'corner',
    'opacity'
  ] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  if (opts.backdrop !== undefined) {
    ;(p as { backdrop: unknown }).backdrop = opts.backdrop
  }
  return layer
}
