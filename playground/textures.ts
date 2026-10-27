/// <reference path="./textures.d.ts" />
// typegpu reads process.env at evaluation: the shim must run first.
import '@/util/env'
import './nav'
import { createEffects } from '@/fx'
import { createCompositor } from '@/index'

// Effect-input textures (M5f): two baked images (npm run bake:playground)
// read by name. `noise` (data, 128 x 128) warps the page in a pass and
// grains a card through a material; `ramp` (colour, 256 x 32, its lower
// half translucent) is drawn 1:1 by a layer over the dashed box, so it
// must equal ramp.png texel for texel. `?vr` is the harness view
// (window.__textures).

const compositor = await createCompositor({
  mode: 'replace',
  assets: '/gpu/manifest.json'
})
compositor.start()
await compositor.ready
const fx = createEffects(compositor)
const noise = fx.texture('noise')
const ramp = fx.texture('ramp')
const vr = new URLSearchParams(location.search).has('vr')

const warp = fx.pass({
  name: 'noise-warp',
  textures: { noise },
  params: {
    strength: { type: 'f32', default: 5, min: 0, max: 30 },
    speed: { type: 'f32', default: vr ? 0 : 0.04, min: 0, max: 1 }
  },
  fragment: /* wgsl */ `
    fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
      // The tile repeats every 256 CSS px (fract), drifting slowly.
      let px = uv * fx.viewport / fx.dpr;
      let t = fract(px / 256.0 + vec2f(fx.time * params.speed));
      let n = tex_noise(t).xy * 2.0 - 1.0;
      return sample(uv - n * params.strength * fx.dpr * fx.texel);
    }`
})

fx.material({
  name: 'grain',
  target: document.getElementById('grain') as Element,
  kinds: ['box'],
  textures: { noise },
  fragment: /* wgsl */ `
    fn fragment(m : MatIn) -> vec4f {
      let n = tex_noise(fract(m.local / 96.0)).b;
      let k = mix(0.7, 1.15, n);
      return vec4f(m.color.rgb * k, m.color.a);
    }`
})

const box = document.getElementById('ramp-box') as HTMLElement
fx.layer({
  name: 'ramp',
  count: 1,
  stride: 1,
  textures: { ramp },
  params: { rect: { type: 'vec4', default: [0, 0, 0, 0] } },
  vertex: /* wgsl */ `
    fn vertex(i : u32, corner : vec2f) -> Quad {
      var q : Quad;
      q.pos = params.rect.xy + corner * params.rect.zw;
      q.uv = corner;
      return q;
    }`,
  fragment: /* wgsl */ `
    fn fragment(q : Quad, i : u32) -> vec4f {
      let c = tex_ramp(q.uv);
      return vec4f(c.rgb * c.a, c.a);
    }`,
  update(l) {
    const r = box.getBoundingClientRect()
    const next = [r.x + scrollX, r.y + scrollY, r.width, r.height]
    const rect = l.params.rect as number[]
    if (next.some((v, i) => v !== rect[i])) {
      l.params.rect = next
    }
  }
})

const toggle = document.getElementById('warp') as HTMLInputElement
toggle.addEventListener('change', () => {
  warp.enabled = toggle.checked
})

window.__textures = {
  ready: () => Promise.all([noise.ready, ramp.ready]),
  warp(on) {
    warp.enabled = on
    toggle.checked = on
  },
  rampRect() {
    const r = box.getBoundingClientRect()
    return [r.x, r.y, r.width, r.height]
  }
}
