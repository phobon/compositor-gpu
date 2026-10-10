// typegpu reads process.env at evaluation: the shim must run first.
import '@/util/env'
import { createEffects } from '@/fx'
import { createCompositor } from '@/index'

// Trail playground: one fx.trail field read by a fullscreen pass
// (displace or pixellate), a light Layer and an image Material.
// `?stroke` deposits a scripted stroke instead of waiting for the
// pointer (used to check it headless).

const $ = (id: string) => document.getElementById(id) as HTMLInputElement

const compositor = await createCompositor({ mode: 'replace' })
compositor.start()
const fx = createEffects(compositor)
const trail = fx.trail({ cell: 16, radius: 90, decay: 0.93 })

const pass = fx.pass({
  name: 'trail-pass',
  trail,
  radius: 48,
  params: {
    mode: { type: 'f32', default: 0, min: 0, max: 1 },
    amount: { type: 'f32', default: 24, min: 0, max: 96 }
  },
  fragment: /* wgsl */ `
    fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
      if (params.mode < 0.5) {
        // Push content back along the stroke.
        let t = trail(uv);
        let off = t.xy * params.amount;
        return sample(uv - off * fx.texel * fx.dpr);
      }
      // Pixellate the cells the trail covers, one block per cell.
      let p = uv_to_viewport(uv);
      let c = trail_cell(p);
      let centre = trail_snap(p) + trail_cell_size() * 0.5;
      let k = smoothstep(0.05, 0.35, c.z);
      return mix(sample(uv), sample(viewport_to_uv(centre)), k);
    }`
})

const light = fx.layer({
  name: 'trail-light',
  count: 1,
  stride: 1,
  space: 'viewport',
  place: 'below',
  trail,
  params: {
    intensity: { type: 'f32', default: 0.35, min: 0, max: 1 },
    tint: { type: 'color', default: '#5b6cff' }
  },
  vertex: /* wgsl */ `
    fn vertex(i : u32, corner : vec2f) -> Quad {
      var q : Quad;
      q.pos = corner * fx.viewport;
      return q;
    }`,
  fragment: /* wgsl */ `
    fn fragment(q : Quad, i : u32) -> vec4f {
      let t = trail_at(q.pos);
      let a = params.intensity * clamp(t.z, 0.0, 1.0) * params.tint.a;
      return vec4f(params.tint.rgb * a, a);
    }`
})

const mat = fx.material({
  name: 'trail-image',
  target: $('img-a'),
  kinds: ['image'],
  trail,
  fragment: /* wgsl */ `
    fn fragment(m : MatIn) -> vec4f {
      let t = trail_page(m.page);
      return mat_sample(-t.xy * 18.0) * m.coverage;
    }`
})

for (const r of document.querySelectorAll<HTMLInputElement>(
  'input[name=mode]'
)) {
  r.addEventListener('change', () => {
    pass.params.mode = r.value === 'pixel' ? 1 : 0
  })
}
$('light').addEventListener('change', (e) => {
  light.enabled = (e.target as HTMLInputElement).checked
})
$('mat').addEventListener('change', (e) => {
  mat.enabled = (e.target as HTMLInputElement).checked
})

const q = new URLSearchParams(location.search)
if (q.has('pixel')) {
  pass.params.mode = 1
}
if (q.has('hold')) {
  trail.params.decay = 1
}
if (q.has('stroke')) {
  trail.stroke({ x: 80, y: 200 }, { x: 900, y: 420 })
}

Object.assign(window, { __gpu: compositor, __fx: fx, __trail: trail })
