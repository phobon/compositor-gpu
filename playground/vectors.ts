/// <reference path="./vectors.d.ts" />
// typegpu reads process.env at evaluation: the shim must run first.
import '@/util/env'
import './nav'
import { createEffects, layoutMorph } from '@/fx'
import { createCompositor } from '@/index'

// Vector images (M5f): the svg files in ./icons, each drawn inline with
// data-gpu-vector and as `<img data-gpu-vector src>`. With `?baked` (npm
// run bake:playground) the imgs draw as vectors from their baked files
// and should match the inline row; without, they draw as images. The
// gradient icon isn't bakeable: it stays an image in both rows (the
// inline one rasterised too). `?vr` is the harness view (window.__vectors).

const ICONS: [string, string][] = [
  ['star', 'sq'],
  ['ring', 'sq'],
  ['badge', 'sq'],
  ['leaf', 'sq'],
  ['wave', 'wide'],
  ['glow-dot', 'sq']
]

const inline = document.getElementById('inline') as HTMLElement
const imgs = document.getElementById('imgs') as HTMLElement
const more = document.getElementById('more') as HTMLElement
const loads: Promise<unknown>[] = []
for (const [name, cls] of ICONS) {
  const src = `/icons/${name}.svg`
  const text = await (await fetch(src)).text()
  const box = document.createElement('div')
  box.className = cls
  box.innerHTML = text.replace(/<\?xml[^>]*\?>/, '')
  const svg = box.querySelector('svg') as SVGSVGElement
  svg.setAttribute('data-gpu-vector', '')
  svg.setAttribute('class', cls)
  svg.removeAttribute('width')
  svg.removeAttribute('height')
  inline.append(svg)
  for (const [row, extra] of [
    [imgs, ''],
    [more, name === 'wave' ? ' pad' : ' tilt']
  ] as const) {
    const img = document.createElement('img')
    img.src = src
    img.alt = ''
    img.className = cls + extra
    img.setAttribute('data-gpu-vector', '')
    loads.push(img.decode().catch(() => {}))
    row.append(img)
  }
}
// One img that morphs between the baked icons (layoutMorph, keyed by
// data-gpu-morph; its shapes pair up as an inline svg's do).
const MORPHS = ['star', 'leaf', 'ring', 'badge']
const morphImg = document.createElement('img')
morphImg.src = `/icons/${MORPHS[0]}.svg`
morphImg.alt = ''
morphImg.className = 'sq'
morphImg.setAttribute('data-gpu-morph', 'icon')
loads.push(morphImg.decode().catch(() => {}))
;(document.getElementById('morph') as HTMLElement).append(morphImg)
await Promise.all(loads)

const compositor = await createCompositor({
  mode: 'replace',
  ...(new URLSearchParams(location.search).has('baked')
    ? { assets: '/gpu/manifest.json' }
    : {})
})
compositor.start()
await compositor.ready
const fx = createEffects(compositor)
const m = layoutMorph(fx)
let at = 0
/** Swap the morphing img to the next icon, the morph held (not played). */
const swap = async (): Promise<void> => {
  await m.capture()
  at = (at + 1) % MORPHS.length
  morphImg.src = `/icons/${MORPHS[at]}.svg`
  await morphImg.decode().catch(() => {})
  await m.settled()
}
let busy = false
document.getElementById('next')?.addEventListener('click', async () => {
  if (busy) {
    return
  }
  busy = true
  await swap()
  await m.play(900)
  busy = false
})
window.__vectors = {
  shapes: () =>
    [...document.querySelectorAll('#imgs img, #more img')].map(
      (el) => fx.pathShapes(el).length
    ),
  async hold(progress) {
    await swap()
    m.progress = progress
  },
  end() {
    m.end()
  }
}
