/// <reference path="./masks.d.ts" />
// typegpu reads process.env at evaluation: the shim must run first.
import '@/util/env'
import './nav'
import { createEffects, glow, type Sdf } from '@/fx'
import { createCompositor } from '@/index'

// Baked distance-field masks (M5f; npm run bake:playground): an svg's
// shape as a distance field computed offline, placed over an element by
// `fx.sdf(el, { mask })` and read like a live field. The star is drawn
// twice, one with a live field, one with the baked "star" mask; the box
// glows with the "badge" mask though it draws nothing like it. `?vr`
// shows each field as grey levels (128 + 8 per CSS px) for the harness
// (window.__masks).

const star = await (await fetch('/icons/star.svg')).text()
for (const id of ['live', 'baked']) {
  const el = document.getElementById(id) as Element
  el.innerHTML = star.replace(/^[\s\S]*?<svg[^>]*>|<\/svg>\s*$/g, '')
}

const compositor = await createCompositor({
  mode: 'replace',
  assets: '/gpu/manifest.json'
})
compositor.start()
await compositor.ready
const fx = createEffects(compositor)
const $ = (id: string): Element => document.getElementById(id) as Element
const vr = new URLSearchParams(location.search).has('vr')

// The baked star's spread is 3 viewBox units: 15 CSS px at 120 px. (One
// field per element: a second live one would take over its isolation.)
let fields: Sdf[] = []
if (vr) {
  fields = [
    fx.sdf($('live'), { spread: 15 }),
    fx.sdf($('baked'), { mask: 'star' })
  ]
  for (const [k, sdf] of fields.entries()) {
    fx.layer({
      name: `field-${k}`,
      count: 1,
      stride: 1,
      sdf,
      vertex: /* wgsl */ `
        fn vertex(i : u32, corner : vec2f) -> Quad {
          var q : Quad;
          let r = fx_sdf_info.rect;
          q.pos = r.xy + corner * r.zw;
          q.uv = q.pos;
          return q;
        }`,
      fragment: /* wgsl */ `
        fn fragment(q : Quad, i : u32) -> vec4f {
          if (!sdf_ready()) {
            return vec4f(0.0);
          }
          let g = clamp((128.0 + 8.0 * sdf(q.uv)) / 255.0, 0.0, 1.0);
          return vec4f(vec3f(g), 1.0);
        }`
    })
  }
} else {
  const look = { color: '#ffcf5c', glowColor: '#ff8a3d' }
  fields = [
    glow(fx, $('live'), { spread: 15, ...look }).sdf,
    glow(fx, $('baked'), { mask: 'star', ...look }).sdf
  ]
}
glow(fx, $('box'), {
  mask: 'badge',
  color: '#9cf2c8',
  glowColor: '#3fd69a',
  offset: 2,
  width: 1.5,
  glow: 8
})

const frame = (): Promise<number> =>
  new Promise((r) => requestAnimationFrame(r))
window.__masks = {
  async ready() {
    for (let i = 0; i < 600 && !fields.every((f) => f.ready); i++) {
      await frame()
    }
    return fields.map((f) => f.ready)
  },
  rects() {
    return ['live', 'baked'].map((id) => {
      const r = $(id).getBoundingClientRect()
      return [r.x, r.y, r.width, r.height]
    })
  }
}
