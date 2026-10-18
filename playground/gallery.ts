/// <reference path="./gallery.d.ts" />
// typegpu reads process.env at evaluation: the shim must run first.
import '@/util/env'
import { createEffects, gallery, radialReveal, vignette } from '@/fx'
import { createCompositor } from '@/index'

// Gallery playground: eight generated images in a grid, shown as a 3D
// carousel (gallery) entered through radialReveal from the pointer and
// left through radialReveal with a white flash (vignette). `?vr` holds
// the ring still (speed 0, rotation 20) for the fx harness.

const q = new URLSearchParams(location.search)
const grid = document.getElementById('grid') as HTMLElement

/** A 400×300 image: a gradient of hue `k`, a disc and a bar. */
function art(k: number): string {
  const c = document.createElement('canvas')
  c.width = 400
  c.height = 300
  const g = c.getContext('2d') as CanvasRenderingContext2D
  const h = (k * 45) % 360
  const grad = g.createLinearGradient(0, 0, 400, 300)
  grad.addColorStop(0, `hsl(${h} 70% 55%)`)
  grad.addColorStop(1, `hsl(${(h + 60) % 360} 70% 25%)`)
  g.fillStyle = grad
  g.fillRect(0, 0, 400, 300)
  g.fillStyle = 'rgba(255, 255, 255, 0.85)'
  g.beginPath()
  g.arc(120 + k * 20, 150, 60, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = 'rgba(0, 0, 0, 0.35)'
  g.fillRect(40, 240, 320, 20)
  return c.toDataURL('image/png')
}
const imgs = Array.from({ length: 8 }, (_, k) => {
  const img = document.createElement('img')
  img.src = art(k)
  img.alt = ''
  grid.append(img)
  return img
})
await Promise.all(imgs.map((i) => i.decode().catch(() => {})))

const compositor = await createCompositor({
  root: document.getElementById('page') as HTMLElement,
  mode: 'replace'
})
compositor.start()
await compositor.ready
const fx = createEffects(compositor)
Object.assign(window, { __gpu: compositor })

const vr = q.has('vr')
const ring = gallery(fx, {
  images: imgs,
  enabled: false,
  backdrop: '#8f8f93',
  speed: vr ? 0 : 14,
  rotation: vr ? 20 : 0
})
const reveal = radialReveal(fx)
const flash = vignette(fx, { enabled: false, amount: 0.35, flash: 0 })

const raf = (): Promise<number> => new Promise((r) => requestAnimationFrame(r))
const ease = (t: number): number => 1 - (1 - t) ** 3

let busy = false
/** Show or hide the ring through a reveal (and a flash when closing). */
async function go(on: boolean, ms = 900): Promise<void> {
  if (busy || ring.enabled === on) {
    return
  }
  busy = true
  await reveal.capture()
  ring.enabled = on
  await reveal.settled()
  flash.enabled = !on
  const start = await raf()
  for (let t = start; t - start < ms; t = await raf()) {
    const p = ease((t - start) / ms)
    reveal.params.progress = p
    flash.params.flash = on ? 0 : 4 * p * (1 - p) * 0.9
  }
  reveal.end()
  flash.enabled = false
  busy = false
}
document.getElementById('open')?.addEventListener('click', () => {
  void go(true)
})
document.getElementById('close')?.addEventListener('click', () => {
  void go(false)
})

window.__gallery = {
  layer: ring,
  show(on) {
    ring.enabled = on
  }
}
