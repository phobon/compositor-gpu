import type { Effects, Pass } from '../effects'
import type { Target } from '../target'

// A shockwave over the visible viewport: a bulge at `origin` that becomes
// a ring travelling outward at `speed` CSS px/s, fading (`decay`, s) and
// gone after `life` s. Where the ring passes it magnifies by up to
// `bulge` (a gaussian `width` CSS px across), and carries a zoom blur
// (`zoom`, `taps` samples), a radial red/blue split growing with distance
// from the origin (`split`) and a fixed-width fringe (`fringe`, CSS px).
// The morph's look (docs/EFFECTS.md, Morph), usable on its own.
//
// play() starts a wave from an element's centre, a page point, or the
// middle of the viewport, and switches the pass off after `life`. The
// wave's age is `fx.elapsed`, so enabling the pass directly (as the
// harness does, with the clock pinned) shows the wave at that age and
// leaves it on. Under reduced motion play() does nothing.

const FRAGMENT = /* wgsl */ `
fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  let age = fx.elapsed;
  let life = max(params.life, 1e-3);
  if (age >= life) {
    return sample(uv);
  }
  // Eases in over 80 ms, fades by decay, and out over the last fifth.
  let s = exp(-age / max(params.decay, 0.01)) * min(1.0, age / 0.08) *
    (1.0 - max(0.0, (age - life * 0.8) / (life * 0.2)));
  let css = fx.viewport / fx.dpr;
  let c = page_to_uv(params.origin) * css;
  let d = uv * css - c;
  let r = length(d);
  // The ring: a gaussian around the front (at the origin when it starts).
  let x = (r - age * params.speed) / max(params.width, 1.0);
  let g = exp(-x * x);
  if (s <= 0.0 || g < 0.004) {
    return sample(uv);
  }
  let ring = s * g;
  let q = c + d * (1.0 - params.bulge * ring);
  let zoom = params.zoom * ring;
  let split = params.split * ring;
  let dir = select(vec2f(0.0), d / max(r, 1e-3), r > 1e-3);
  let fr = dir * params.fringe * ring;
  // Fewer taps where the ring is faint.
  let n = max(u32(ceil(params.taps * g)), 1u);
  var acc = vec4f(0.0);
  for (var j = 0u; j < n; j++) {
    var k = 0.0;
    if (n > 1u) {
      k = (f32(j) / f32(n - 1u) - 0.5) * zoom;
    }
    let cr = sample((c + (q - c) * (1.0 + k + split) + fr) / css);
    let cg = sample((c + (q - c) * (1.0 + k)) / css);
    let cb = sample((c + (q - c) * (1.0 + k - split) - fr) / css);
    acc += vec4f(cr.r, cg.g, cb.b, max(max(cr.a, cg.a), cb.a));
  }
  return acc / f32(n);
}
`

const schema = {
  /** Page (document) CSS px; play() sets it. */
  origin: { type: 'vec2', default: [0, 0] },
  /** CSS px per second. */
  speed: { type: 'f32', default: 520, min: 0, max: 4000 },
  /** Seconds until the wave is gone. */
  life: { type: 'f32', default: 2.2, min: 0.1, max: 10 },
  /** Fade time constant, seconds. */
  decay: { type: 'f32', default: 0.9, min: 0.05, max: 10 },
  /** Magnification at the ring's peak, 0..0.9. */
  bulge: { type: 'f32', default: 0.22, min: 0, max: 0.9 },
  /** Ring width, CSS px. */
  width: { type: 'f32', default: 140, min: 10, max: 800 },
  /** Zoom blur length, as a fraction of the distance from the origin. */
  zoom: { type: 'f32', default: 0.08, min: 0, max: 0.4 },
  /** Red/blue split growing with distance, fraction. */
  split: { type: 'f32', default: 0.03, min: 0, max: 0.1 },
  /** Red/blue fringe, CSS px. */
  fringe: { type: 'f32', default: 6, min: 0, max: 40 },
  taps: { type: 'f32', default: 8, min: 1, max: 16 }
} as const

export type ShockwaveSchema = typeof schema

export interface ShockwaveOptions {
  speed?: number
  life?: number
  decay?: number
  bulge?: number
  width?: number
  zoom?: number
  split?: number
  fringe?: number
  taps?: number
  /** Default false: off until play(). */
  enabled?: boolean
  name?: string
}

export interface Shockwave {
  readonly pass: Pass<ShockwaveSchema>
  /**
   * Start a wave now from `at`: an element's or target's centre, a page
   * (document) point in CSS px, or (absent) the middle of the viewport.
   * A wave already running restarts. Nothing under reduced motion.
   */
  play(at?: Element | Target | [number, number]): void
  destroy(): void
}

const isTarget = (v: unknown): v is Target =>
  typeof v === 'object' && v !== null && 'rect' in v && 'found' in v

export function shockwave(
  fx: Effects,
  opts: ShockwaveOptions = {}
): Shockwave {
  const pass = fx.pass({
    name: opts.name ?? 'shockwave',
    fragment: FRAGMENT,
    params: schema,
    // The fringe reaches outward by `fringe`; the zoom samples are
    // clamped to what the scene holds.
    radius: (p) => p.fringe + 32,
    enabled: opts.enabled ?? false
  })
  const p = pass.params
  for (const k of [
    'speed',
    'life',
    'decay',
    'bulge',
    'width',
    'zoom',
    'split',
    'fringe',
    'taps'
  ] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const originOf = (
    at: Element | Target | [number, number] | undefined
  ): [number, number] => {
    if (Array.isArray(at)) {
      return at
    }
    if (at) {
      // A target's rect is the mirror's (no layout read); an element
      // goes through its target.
      const t = isTarget(at) ? at : fx.target(at)
      if (t.found) {
        const r = t.rect
        const vx = t.space === 'viewport' ? window.scrollX : 0
        const vy = t.space === 'viewport' ? window.scrollY : 0
        return [r.x + r.width / 2 + vx, r.y + r.height / 2 + vy]
      }
    }
    return [
      window.scrollX + window.innerWidth / 2,
      window.scrollY + window.innerHeight / 2
    ]
  }
  return {
    pass,
    play(at) {
      if (fx.reducedMotion) {
        return
      }
      p.origin = originOf(at)
      // Re-enabling restarts fx.elapsed: the wave's age.
      pass.enabled = false
      pass.enabled = true
      clearTimeout(timer)
      timer = setTimeout(
        () => {
          pass.enabled = false
        },
        p.life * 1000 + 50
      )
    },
    destroy() {
      clearTimeout(timer)
      pass.destroy()
    }
  }
}
