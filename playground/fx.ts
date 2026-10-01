/// <reference path="./fx.d.ts" />
// typegpu reads process.env at evaluation: the shim must run first.
import '@/util/env'
import tgpu from 'typegpu'
import * as d from 'typegpu/data'
import { blur, createEffects, displace, type Pass } from '@/fx'
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
function bindPanel(key: string, pass: Pass): void {
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
  bindPanel('blur', b)
  bindPanel('displace', dsp)
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
