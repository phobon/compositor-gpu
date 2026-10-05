/// <reference path="./fx.d.ts" />
// typegpu reads process.env at evaluation: the shim must run first.
import '@/util/env'
import tgpu from 'typegpu'
import * as d from 'typegpu/data'
import {
  blur,
  clickRipple,
  createEffects,
  cursorGlow,
  displace,
  type Layer,
  type Pass
} from '@/fx'
import { createCompositor } from '@/index'

// Effects playground: the mirror plus `compositor-gpu/fx` with the blur
// and displace presets. `?vr` hides the control panel and pins time and
// pointer for test/fx/run.ts.

const $ = (id: string) => document.getElementById(id) as HTMLElement
const logEl = $('log')
const origErr = console.error.bind(console)
console.error = (...args: unknown[]) => {
  origErr(...args)
  logEl.textContent += `${args.join(' ')}\n`
}

const vrMode = new URLSearchParams(location.search).has('vr')
if (vrMode) {
  document.body.classList.add('vr')
}

function raf2(): Promise<void> {
  return new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r()))
  )
}

function imagesReady(): Promise<void> {
  return Promise.all(
    Array.from(document.images).map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((r) => {
            img.addEventListener('load', () => r(), { once: true })
            img.addEventListener('error', () => r(), { once: true })
          })
    )
  ).then(() => undefined)
}

/** Bind a checkbox to `pass.enabled` and each slider to a param. */
function bindPanel(key: string, pass: Pass | Layer): void {
  const box = $(`c-${key}`) as HTMLInputElement
  box.checked = pass.enabled
  box.addEventListener('change', () => {
    pass.enabled = box.checked
  })
  const params = pass.params as Record<string, number>
  for (const input of document.querySelectorAll<HTMLInputElement>(
    `[id^="s-${key}-"]`
  )) {
    const name = input.id.slice(`s-${key}-`.length)
    const out = input.nextElementSibling as HTMLOutputElement | null
    input.value = String(params[name])
    if (out) {
      out.value = String(params[name])
    }
    input.addEventListener('input', () => {
      params[name] = Number(input.value)
      if (out) {
        out.value = input.value
      }
    })
  }
}

async function boot(): Promise<void> {
  const compositor = await createCompositor({
    root: $('stage'),
    fonts: 'auto'
  })
  const fx = createEffects(compositor)
  const b = blur(fx, { enabled: false, radius: 10 })
  const dsp = displace(fx, {
    enabled: false,
    strength: 8,
    scale: 60,
    pointerStrength: 60,
    pointerRadius: 220
  })
  if (vrMode) {
    // Centre of a 1280×900 viewport; follower settled on it.
    fx.__override({
      time: 1.25,
      elapsed: 1.25,
      pointer: { x: 640, y: 450, follow: { x: 640, y: 450 } }
    })
  }
  // Geometry (M2): layers in paint order and a region pass.
  const glow = cursorGlow(fx, {
    enabled: false,
    place: 'below',
    radius: 260,
    intensity: 0.5,
    color: '#60a5fa'
  })
  const ripple = clickRipple(fx, {
    enabled: false,
    radius: 120,
    width: 3,
    duration: 1,
    color: '#f472b6'
  })
  const region = blur(fx, {
    name: 'region-blur',
    enabled: false,
    radius: 6,
    region: $('region-card')
  })
  // A quad straddling the first three boxes, drawn right after the blue
  // one: over it, under the two that follow.
  const anchor = fx.target($('after-anchor'))
  const after = fx.layer({
    name: 'after-quad',
    count: 1,
    stride: 1,
    place: { after: anchor },
    enabled: false,
    vertex: /* wgsl */ `
      fn vertex(i : u32, corner : vec2f) -> Quad {
        var q : Quad;
        q.pos = params.rect.xy + corner * params.rect.zw;
        q.uv = corner;
        return q;
      }`,
    fragment: /* wgsl */ `
      fn fragment(q : Quad, i : u32) -> vec4f {
        let a = 0.9;
        return vec4f(vec3f(0.98, 0.98, 0.98) * a, a);
      }`,
    params: { rect: { type: 'vec4', default: [0, 0, 0, 0] } },
    update(l) {
      // Follow the anchor: a band through the middle of the row, from the
      // blue box's centre to past the third box.
      const r = anchor.rect
      const rect = l.params.rect as number[]
      const next = [r.x + r.width / 2, r.y + r.height * 0.35, 260, r.height * 0.3]
      if (next.some((v, i) => v !== rect[i])) {
        l.params.rect = next
      }
    }
  })
  bindPanel('blur', b)
  bindPanel('displace', dsp)
  bindPanel('glow', glow)
  bindPanel('ripple', ripple)
  bindPanel('region', region)
  bindPanel('after', after)
  // A TypeGPU fragment (WGSL-bodied tgpu.fn): premultiplied invert.
  const invert = tgpu.fn(
    [d.vec2f, d.texture2d(d.f32), d.sampler()],
    d.vec4f
  )(`(uv, src, smp) {
    let c = sample(uv);
    return vec4f(mix(c.rgb, vec3f(c.a) - c.rgb, params.amount), c.a);
  }`)
  const inv = fx.pass({
    name: 'tgpu-invert',
    fragment: invert,
    params: { amount: { type: 'f32', default: 1, min: 0, max: 1 } },
    enabled: false
  })

  const textReady = (): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (!compositor.text || compositor.text.ready) {
          resolve()
        } else {
          requestAnimationFrame(check)
        }
      }
      check()
    })

  window.__fx = {
    ready: (async () => {
      if (!compositor.active) {
        return
      }
      await textReady()
      await document.fonts.ready
      await imagesReady()
      await raf2()
    })(),
    fx,
    blur: b,
    displace: dsp,
    tgpu: inv,
    glow,
    ripple,
    region,
    after,
    pinClicks() {
      // Two clicks at the viewport centre, 0.2 s and 0.5 s old at the
      // pinned time.
      const x = window.scrollX + 640
      const y = window.scrollY + 450
      fx.__override({
        time: 1.25,
        elapsed: 1.25,
        pointer: {
          x: 640,
          y: 450,
          follow: { x: 640, y: 450 },
          clicks: [
            { x, y, t: 1.05 },
            { x: x - 160, y: y + 60, t: 0.75 }
          ]
        }
      })
    },
    async setMode(mode) {
      const cv = compositor.canvas
      if (cv) {
        compositor.setSourceHidden(mode === 'gpu')
        cv.style.visibility = mode === 'dom' ? 'hidden' : 'visible'
      }
      await raf2()
    },
    stats: () => compositor.stats(),
    stop: () => compositor.stop(),
    start: () => compositor.start(),
    raf2
  }

  if (!compositor.active) {
    logEl.textContent = 'WebGPU unavailable — showing the plain DOM.'
    return
  }
  compositor.start()
  window.addEventListener('load', () => compositor.invalidate())
}

void boot()
