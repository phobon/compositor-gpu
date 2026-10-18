import type { Effects } from '../effects'
import type { Material } from '../material'
import type { Target } from '../target'

// Letters rise and fade in one after another as `progress` goes 0 -> 1:
// glyph k of n arrives over its own window of progress, offset by
// k / n × spread (`mat_index` numbers the target's glyphs in DOM order).
// The page drives `params.progress` (GSAP, Motion) and destroys the
// material at 1, where it draws as the plain text. `hold` keeps the
// glyphs hidden until the pipeline compiles, so they never flash in at
// rest first.

const ARRIVE = /* wgsl */ `
fn arrive(record : u32) -> f32 {
  let n = max(fx.glyphs - 1.0, 1.0);
  let k = f32(mat_index(record)) / n;
  let t = clamp(params.progress * (1.0 + params.spread) - k * params.spread,
    0.0, 1.0);
  return 1.0 - pow(1.0 - t, 3.0);
}
`

const VERTEX = /* wgsl */ `${ARRIVE}
fn vertex(local : vec2f, size : vec2f, uv : vec2f, record : u32) -> vec2f {
  return local + vec2f(0.0, (1.0 - arrive(record)) * params.rise);
}
`

const FRAGMENT = /* wgsl */ `
fn fragment(m : MatIn) -> vec4f {
  return m.color * arrive(m.record);
}
`

const schema = {
  progress: { type: 'f32', default: 0, min: 0, max: 1 },
  spread: { type: 'f32', default: 2, min: 0, max: 8 },
  rise: { type: 'f32', default: 14, min: 0, max: 80 }
} as const

export type TextStaggerSchema = typeof schema

export interface TextStaggerOptions {
  /** The element whose glyphs arrive. */
  target: Target | Element
  /** Default 0 (hidden). */
  progress?: number
  /** How far the letters' windows are spread, × the whole run. Default 2. */
  spread?: number
  /** CSS px each letter rises from. Default 14. */
  rise?: number
  enabled?: boolean
  name?: string
}

export function textStagger(
  fx: Effects,
  opts: TextStaggerOptions
): Material<TextStaggerSchema> {
  const mat = fx.material({
    name: opts.name ?? 'text-stagger',
    target: opts.target,
    kinds: ['glyph'],
    params: schema,
    hold: true,
    vertex: VERTEX,
    fragment: FRAGMENT,
    enabled: opts.enabled
  })
  const p = mat.params
  for (const k of ['progress', 'spread', 'rise'] as const) {
    const v = opts[k]
    if (v !== undefined) {
      p[k] = v
    }
  }
  return mat
}
