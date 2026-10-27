/// <reference path="./sdf.d.ts" />
// typegpu reads process.env at evaluation: the shim must run first.
import '@/util/env'
import './nav'
import { createEffects, type Glow, glow } from '@/fx'
import { createCompositor } from '@/index'

// Distance field playground (M5e): `glow` on a heading, a card, a vector
// svg and an image, each from its element's distance field (fx.sdf).
// Edit the heading (contenteditable) to see its field rebuild. `?off`
// starts without them; `?vr` is the harness view (window.__sdf).

// `?baked`: baked fonts (npm run bake:playground; the heading's weight
// isn't baked, so it falls back to parsing the font).
const compositor = await createCompositor({
  mode: 'replace',
  ...(new URLSearchParams(location.search).has('baked')
    ? { assets: '/gpu/manifest.json' }
    : {})
})
compositor.start()
await compositor.ready
const fx = createEffects(compositor)

const make = (): Glow[] => [
  glow(fx, document.getElementById('word') as Element, {
    color: '#ffffff',
    glowColor: '#7aa2ff',
    glow: 18,
    offset: 4
  }),
  glow(fx, document.getElementById('card') as Element, {
    color: '#ff8a5c',
    glowColor: '#ff8a5c',
    width: 3,
    offset: 6,
    glow: 14
  }),
  glow(fx, document.getElementById('icon') as Element, {
    color: '#ffcf5c',
    glowColor: '#ffcf5c',
    width: 0,
    glow: 16,
    strength: 0.9
  }),
  glow(fx, document.getElementById('pic') as Element, {
    color: '#9cf2c8',
    glowColor: '#3fd69a',
    width: 2,
    offset: 5,
    glow: 12
  })
]
// `?off`: start with none (the plain page).
const q = new URLSearchParams(location.search)
let glows = q.has('off') ? [] : make()
const word = document.getElementById('word') as HTMLElement
word.contentEditable = 'true'

const raf = (): Promise<number> => new Promise((r) => requestAnimationFrame(r))
const set = async (on: boolean): Promise<void> => {
  for (const g of glows) {
    g.destroy()
  }
  glows = on ? make() : []
  await raf()
}
const box = document.getElementById('on') as HTMLInputElement
box.checked = glows.length > 0
box.addEventListener('change', () => {
  void set(box.checked)
})

window.__sdf = {
  get glows() {
    return glows
  },
  async built() {
    for (let i = 0; i < 600 && !glows.every((g) => g.sdf.ready); i++) {
      await raf()
    }
  },
  set
}
Object.assign(window, { __gpu: compositor, __fx: fx })
