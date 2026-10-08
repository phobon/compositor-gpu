/// <reference path="./fx.d.ts" />
// typegpu reads process.env at evaluation: the shim must run first.
import '@/util/env'
import {
  createDialKit,
  createDialRoot,
  type DialConfig,
  type TransitionConfig
} from 'dialkit/vanilla'
import tgpu from 'typegpu'
import * as d from 'typegpu/data'
import * as std from 'typegpu/std'
import {
  blur,
  clickRipple,
  createEffects,
  cursorGlow,
  displace,
  dissolve,
  gpu,
  ripple as imageRipple,
  type Layer,
  type Material,
  MatIn,
  type Pass,
  progressiveBlur
} from '@/fx'
import { createCompositor } from '@/index'
import 'dialkit/vanilla/styles.css'

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

type Effect = Pass | Layer | Material
/** An effect's DialKit folder: its toggle and its params' ranges. */
interface Dial {
  name: string
  effect: Effect
  params?: Record<string, [number, number, number]>
}

/** cubic-bezier(x1, y1, x2, y2) at progress x (DialKit easing curves). */
function bezier(e: readonly number[], x: number): number {
  const [x1 = 0, y1 = 0, x2 = 1, y2 = 1] = e
  const at = (a: number, b: number, t: number): number =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (at(x1, x2, mid) < x) {
      lo = mid
    } else {
      hi = mid
    }
  }
  return at(y1, y2, (lo + hi) / 2)
}

/** The DialKit panel: a folder per effect (on/off and its params). */
function mountDials(
  dials: Dial[],
  extra: DialConfig,
  onAction: (a: string) => void
): ReturnType<typeof createDialKit> {
  const config: DialConfig = {}
  for (const d of dials) {
    const params = d.effect.params as Record<string, number>
    const folder: DialConfig = { _collapsed: true, enabled: d.effect.enabled }
    for (const [k, [min, max, step]] of Object.entries(d.params ?? {})) {
      folder[k] = [params[k] ?? min, min, max, step]
    }
    config[d.name] = folder
  }
  Object.assign(config, extra)
  createDialRoot({ position: 'top-right', theme: 'dark' })
  const kit = createDialKit('Effects', config, { onAction })
  kit.subscribe((values) => {
    const v = values as Record<string, Record<string, number | boolean>>
    for (const d of dials) {
      const f = v[d.name]
      if (!f) {
        continue
      }
      d.effect.enabled = f.enabled === true
      const params = d.effect.params as Record<string, number>
      for (const k of Object.keys(d.params ?? {})) {
        const x = f[k]
        if (typeof x === 'number') {
          params[k] = x
        }
      }
    }
  })
  return kit
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
  const progressive = progressiveBlur(fx, {
    enabled: false,
    radius: 14,
    edges: [0, 1, 1, 1],
    width: [0.3, 0.7],
    corners: 1,
    region: $('orbit')
  })
  // Dissolve on the transform row: half way, with a rim.
  const dsv = dissolve(fx, $('tf-row'), {
    enabled: false,
    progress: 0.5,
    edge: 0.06,
    edgeColor: '#f472b6'
  })
  // Layer transforms on three cards: pinned states for the harness, a
  // staggered scale-in on click.
  const tf = [0, 1, 2].map((i) =>
    fx.transform($(`tf-${i}`), { enabled: false })
  )
  const TF_PIN = [
    { scale: 0.85, y: 40, opacity: 0.5 },
    { scale: 0.92, y: 20, rotate: -4 },
    { x: 140, rotate: 6 }
  ]
  const tfIdentity = { x: 0, y: 0, scale: 1, rotate: 0, opacity: 1 }
  // Motions on the same cards (harness: fx-motion). Card 0 half way from
  // { scale 0.5, y 64, opacity 0 }; card 1 at its start (scale 0.5),
  // composed with a transform's rotate -4; card 2 at rest. 'ref' sets the
  // equivalent single transforms instead: the two must match exactly.
  const mo = [
    fx.motion($('tf-0'), {
      from: { scale: 0.5, y: 64, opacity: 0 },
      progress: 0.5,
      enabled: false
    }),
    fx.motion($('tf-1'), { from: { scale: 0.5 }, enabled: false }),
    fx.motion($('tf-2'), { from: { x: 80 }, progress: 1, enabled: false })
  ]
  const moSet = (mode: 'off' | 'motion' | 'ref'): void => {
    for (const m of mo) {
      m.enabled = mode === 'motion'
    }
    if (mode === 'off') {
      return
    }
    const pin = [
      { scale: 0.75, y: 32, opacity: 0.5 },
      { rotate: -4, scale: 0.5 },
      {}
    ]
    tf.forEach((t, i) => {
      Object.assign(
        t,
        tfIdentity,
        mode === 'ref' ? pin[i] : i === 1 ? { rotate: -4 } : {}
      )
      t.enabled = mode === 'ref' ? i < 2 : i === 1
    })
  }
  const tfSet = (mode: 'off' | 'identity' | 'pinned'): void => {
    tf.forEach((t, i) => {
      Object.assign(t, tfIdentity, mode === 'pinned' ? TF_PIN[i] : {})
      t.enabled = mode !== 'off'
    })
  }
  // The stagger's settings, tuned from the panel's Layer transforms folder.
  const tfAnim = {
    fromScale: 0.8,
    fromY: 60,
    fromRotate: 0,
    fromOpacity: 0,
    stagger: 0.12,
    transition: {
      type: 'easing',
      duration: 0.7,
      ease: [0.22, 1, 0.36, 1]
    } as TransitionConfig
  }
  const tfPlay = (): void => {
    const a = tfAnim
    const tr = a.transition
    const dur = tr.type === 'easing' ? tr.duration : (tr.visualDuration ?? 0.5)
    const ease = tr.type === 'easing' ? tr.ease : [0.22, 1, 0.36, 1]
    const start = performance.now()
    tf.forEach((t) => {
      t.enabled = true
    })
    const step = (now: number): void => {
      let busy = false
      tf.forEach((t, i) => {
        const k = Math.min(
          1,
          Math.max(0, ((now - start) / 1000 - i * a.stagger) / dur)
        )
        const e = bezier(ease, k)
        t.scale = a.fromScale + (1 - a.fromScale) * e
        t.y = a.fromY * (1 - e)
        t.rotate = a.fromRotate * (1 - e)
        t.opacity = a.fromOpacity + (1 - a.fromOpacity) * e
        busy ||= k < 1
      })
      if (busy) {
        requestAnimationFrame(step)
      }
    }
    requestAnimationFrame(step)
  }
  if (!vrMode) {
    $('tf-row').addEventListener('click', tfPlay)
  }

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
      const next = [
        r.x + r.width / 2,
        r.y + r.height * 0.35,
        260,
        r.height * 0.3
      ]
      if (next.some((v, i) => v !== rect[i])) {
        l.params.rect = next
      }
    }
  })
  // Materials (M3).
  const mripple = imageRipple(fx, $('mat-img'), {
    enabled: false,
    amplitude: 10,
    duration: 1.5
  })
  const wave = fx.material({
    name: 'wave',
    target: $('mat-heading'),
    kinds: ['glyph'],
    enabled: false,
    params: { amount: { type: 'f32', default: 6, min: 0, max: 20 } },
    vertex: /* wgsl */ `
      fn vertex(local : vec2f, size : vec2f, uv : vec2f, record : u32)
          -> vec2f {
        let ph = f32(record) * 0.55 + fx.time * 4.0;
        return local + vec2f(0.0, sin(ph) * params.amount);
      }`,
    fragment: /* wgsl */ `
      fn fragment(m : MatIn) -> vec4f {
        // Tint by the same phase, so the wave reads in colour too.
        let k = 0.5 + 0.5 * sin(f32(m.record) * 0.55 + fx.time * 4.0);
        let rgb = mix(vec3f(1.0), vec3f(0.96, 0.62, 0.04), k);
        return vec4f(rgb * m.color.a, m.color.a);
      }`
  })
  const bend = fx.material({
    name: 'bend',
    target: $('mat-img'),
    kinds: ['image'],
    subdivisions: 16,
    enabled: false,
    params: { amount: { type: 'f32', default: 40, min: -80, max: 80 } },
    vertex: /* wgsl */ `
      fn vertex(local : vec2f, size : vec2f, uv : vec2f, record : u32)
          -> vec2f {
        // A page curl: lift the right edge, more towards the bottom.
        let k = uv.x * uv.x * (0.4 + 0.6 * uv.y);
        return local + vec2f(-k * params.amount * 0.4, -k * params.amount);
      }`
  })
  const tint = fx.material({
    name: 'stripes',
    target: $('mat-box'),
    kinds: ['box'],
    enabled: false,
    fragment: /* wgsl */ `
      fn fragment(m : MatIn) -> vec4f {
        let s = step(0.5, fract((m.local.x + m.local.y) / 16.0));
        return mix(m.color, vec4f(m.coverage), s * 0.35);
      }`
  })
  // M3b: layers that draw a target's glyphs and image, a simulated layer,
  // a raw material, and JS-bodied ('use gpu') TypeGPU hooks.
  const lgHeading = fx.target($('lg-heading'))
  const lglyphs = fx.layer({
    name: 'layer-glyphs',
    count: 0,
    stride: 1,
    glyphs: lgHeading,
    enabled: false,
    params: { drop: { type: 'f32', default: 420, min: 0, max: 600 } },
    vertex: /* wgsl */ `
      fn vertex(i : u32, corner : vec2f) -> Quad {
        // The heading's glyph i, dropped below the row, in a wave.
        var q : Quad;
        q.pos = glyph_point(i, corner) +
          vec2f(0.0, params.drop + sin(f32(i) * 0.8) * 10.0);
        q.uv = corner;
        q.color = glyph_color(i);
        return q;
      }`,
    fragment: /* wgsl */ `
      fn fragment(q : Quad, i : u32) -> vec4f {
        let a = glyph_coverage(i, q.uv) * q.color.a;
        let rgb = mix(vec3f(0.98, 0.45, 0.6), vec3f(0.4, 0.75, 1.0),
          f32(i) / max(f32(glyph_count()), 1.0));
        return vec4f(rgb * a, a);
      }`,
    update(l) {
      const n = lgHeading.glyphs.count
      if (l.count !== n) {
        l.count = n
      }
    }
  })
  const lgImg = fx.target($('lg-img'))
  const limage = fx.layer({
    name: 'layer-image',
    count: 4,
    stride: 1,
    image: lgImg,
    enabled: false,
    params: {
      origin: { type: 'vec2', default: [0, 0] },
      size: { type: 'vec2', default: [0, 0] },
      gap: { type: 'f32', default: 12, min: 0, max: 40 }
    },
    vertex: /* wgsl */ `
      fn vertex(i : u32, corner : vec2f) -> Quad {
        // The image as four tiles pulled apart.
        let cell = vec2f(f32(i % 2u), f32(i / 2u));
        let half = params.size * 0.5;
        var q : Quad;
        q.pos = params.origin + cell * (half + params.gap) + corner * half;
        q.uv = (cell + corner) * 0.5;
        return q;
      }`,
    fragment: /* wgsl */ `
      fn fragment(q : Quad, i : u32) -> vec4f {
        return image(q.uv);
      }`,
    update(l) {
      const r = lgImg.rect
      const origin = [r.x + 620, r.y]
      if (origin.some((v, i) => v !== l.params.origin[i])) {
        l.params.origin = origin
        l.params.size = [r.width, r.height]
      }
    }
  })
  const simSchema = {
    pull: { type: 'f32', default: 30, min: 0, max: 60 }
  } as const
  const simP = gpu.params(simSchema)
  const L = gpu.layer
  // Each dot eases towards its target: positions live on the GPU.
  const simulate = tgpu.fn([d.u32])((i) => {
    'use gpu'
    const p = L.data2(i, 0)
    const target = L.data2(i, 2)
    const k = std.min(1, L.dt.$ * simP.pull.$)
    L.setData2(i, 0, std.add(p, std.mul(std.sub(target, p), k)))
  })
  const section = fx.target($('lg-heading').closest('section') as Element)
  let seeded = false
  const sim = fx.layer({
    name: 'sim-dots',
    count: 64,
    stride: 4,
    enabled: false,
    params: simSchema,
    simulate,
    vertex: /* wgsl */ `
      fn vertex(i : u32, corner : vec2f) -> Quad {
        var q : Quad;
        q.pos = data2(i, 0) + (corner - 0.5) * 10.0;
        q.uv = corner;
        return q;
      }`,
    fragment: /* wgsl */ `
      fn fragment(q : Quad, i : u32) -> vec4f {
        let r = length(q.uv - 0.5) * 10.0;
        let a = clamp(4.5 - r, 0.0, 1.0);
        return vec4f(vec3f(0.98, 0.8, 0.3) * a, a);
      }`,
    update(l) {
      if (seeded || !section.found) {
        return
      }
      // Seed: every dot at one point, targets on an 8 × 8 grid.
      const r = section.rect
      const sx = r.x + r.width - 230
      const sy = r.y + 70
      for (let i = 0; i < 64; i++) {
        l.data.set(
          [sx - 300, sy + 220, sx + (i % 8) * 24, sy + Math.floor(i / 8) * 24],
          i * 4
        )
      }
      l.markDirty()
      seeded = true
    }
  })
  const raw = fx.material({
    name: 'raw-box',
    target: $('raw-box'),
    enabled: false,
    raw: {
      box: /* wgsl */ `
        @vertex
        fn vs(@builtin(vertex_index) vi : u32,
              @builtin(instance_index) ii : u32) -> VOut {
          // The pass's own vertex stage, then nudged right in clip space.
          var o = default_vs(vi, ii);
          o.pos.x = o.pos.x + 0.04 * o.pos.w;
          return o;
        }
        @fragment
        fn fs(in : VOut) -> @location(0) vec4f {
          let c = default_fs(in);
          return vec4f(c.b, c.r, c.g, c.a);
        }`
    }
  })
  const tgFragment = tgpu.fn(
    [MatIn],
    d.vec4f
  )((m) => {
    'use gpu'
    const s = std.step(0.5, std.fract((m.local.x - m.local.y) / 20))
    const gold = d.vec4f(m.color.w, m.color.w * 0.8, 0, m.color.w)
    return std.mix(m.color, gold, s * 0.6)
  })
  const tgbox = fx.material({
    name: 'tgpu-box',
    target: $('tg-box'),
    kinds: ['box'],
    enabled: false,
    fragment: tgFragment
  })
  const tgjsSchema = {
    amount: { type: 'f32', default: 1, min: 0, max: 1 }
  } as const
  const tgjsP = gpu.params(tgjsSchema)
  const grey = tgpu.fn(
    [d.vec2f, d.texture2d(d.f32), d.sampler()],
    d.vec4f
  )((uv, _src, _smp) => {
    'use gpu'
    const c = gpu.pass.sample(uv)
    const g = std.dot(c.xyz, d.vec3f(0.299, 0.587, 0.114))
    return d.vec4f(std.mix(c.xyz, d.vec3f(g, g, g), tgjsP.amount.$), c.w)
  })
  const tgjs = fx.pass({
    name: 'tgpu-grey',
    fragment: grey,
    params: tgjsSchema,
    enabled: false
  })
  // Per-letter stagger: mat_index is the glyph's index in the heading.
  const stagger = fx.material({
    name: 'stagger',
    target: $('stg-heading'),
    kinds: ['glyph'],
    enabled: false,
    params: { delay: { type: 'f32', default: 0.06, min: 0, max: 0.3 } },
    vertex: /* wgsl */ `
      fn arrive(record : u32) -> f32 {
        let k = f32(mat_index(record));
        return clamp(fx.elapsed * 1.2 - k * params.delay, 0.0, 1.0);
      }
      fn vertex(local : vec2f, size : vec2f, uv : vec2f, record : u32)
          -> vec2f {
        let t = arrive(record);
        return local + vec2f(0.0, (1.0 - t) * (1.0 - t) * -28.0);
      }`,
    fragment: /* wgsl */ `
      fn fragment(m : MatIn) -> vec4f {
        return m.color * arrive(m.record);
      }`
  })
  // A fullscreen pass with the materials image inset top right.
  const pimage = fx.pass({
    name: 'pass-image',
    image: $('mat-img'),
    enabled: false,
    fragment: /* wgsl */ `
      fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
        let r = vec4f(0.72, 0.06, 0.22, 0.3);
        let q = (uv - r.xy) / r.zw;
        let c = sample(uv);
        if (any(q < vec2f(0.0)) || any(q > vec2f(1.0))) {
          return c;
        }
        let i = image(q);
        return i + c * (1.0 - i.a);
      }`
  })
  if (!vrMode) {
    const kit = mountDials(
      [
        { name: 'blur', effect: b, params: { radius: [0, 64, 0.5] } },
        {
          name: 'displace',
          effect: dsp,
          params: {
            strength: [0, 40, 0.5],
            scale: [4, 400, 1],
            speed: [0, 4, 0.05],
            pointerStrength: [0, 80, 1],
            pointerRadius: [8, 600, 1],
            mode: [0, 1, 1]
          }
        },
        {
          name: 'progressiveBlur',
          effect: progressive,
          params: { radius: [0, 64, 0.5], curve: [0.25, 4, 0.05] }
        },
        {
          name: 'dissolve',
          effect: dsv,
          params: {
            progress: [0, 1, 0.01],
            scale: [2, 200, 1],
            softness: [0, 0.5, 0.01],
            sweep: [0, 1, 0.01],
            edge: [0, 0.3, 0.005]
          }
        },
        {
          name: 'cursorGlow',
          effect: glow,
          params: { radius: [8, 800, 1], intensity: [0, 1, 0.01] }
        },
        {
          name: 'clickRipple',
          effect: ripple,
          params: { radius: [4, 600, 1], duration: [0.05, 5, 0.05] }
        },
        {
          name: 'regionBlur',
          effect: region,
          params: { radius: [0, 64, 0.5] }
        },
        { name: 'layerAfterBlueBox', effect: after },
        {
          name: 'imageRipple',
          effect: mripple,
          params: { amplitude: [0, 40, 0.5] }
        },
        { name: 'headingWave', effect: wave, params: { amount: [0, 20, 0.5] } },
        { name: 'imageBend', effect: bend, params: { amount: [-80, 80, 1] } },
        { name: 'boxStripes', effect: tint },
        {
          name: 'layerHeadingGlyphs',
          effect: lglyphs,
          params: { drop: [0, 200, 1] }
        },
        {
          name: 'layerImageTiles',
          effect: limage,
          params: { gap: [0, 40, 1] }
        },
        { name: 'simulatedDots', effect: sim, params: { pull: [0, 60, 1] } },
        { name: 'rawMaterial', effect: raw },
        { name: 'useGpuMaterial', effect: tgbox },
        {
          name: 'letterStagger',
          effect: stagger,
          params: { delay: [0, 0.3, 0.01] }
        },
        { name: 'passSamplingImage', effect: pimage },
        { name: 'useGpuPass', effect: tgjs, params: { amount: [0, 1, 0.01] } }
      ],
      {
        layerTransforms: {
          fromScale: [tfAnim.fromScale, 0.2, 1.5, 0.01],
          fromY: [tfAnim.fromY, -200, 200, 1],
          fromRotate: [tfAnim.fromRotate, -45, 45, 0.5],
          fromOpacity: [tfAnim.fromOpacity, 0, 1, 0.01],
          stagger: [tfAnim.stagger, 0, 0.6, 0.01],
          transition: tfAnim.transition,
          replay: { type: 'action', label: 'Replay stagger' }
        }
      },
      (action) => {
        if (action === 'layerTransforms.replay') {
          tfPlay()
        }
      }
    )
    kit.subscribe((values) => {
      const t = (values as { layerTransforms?: typeof tfAnim }).layerTransforms
      if (t) {
        Object.assign(tfAnim, t)
      }
    })
  }
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
    progressive,
    dissolve: dsv,
    tfSet,
    moSet,
    after,
    mripple,
    wave,
    bend,
    tint,
    lglyphs,
    limage,
    stagger,
    pimage,
    sim,
    raw,
    tgbox,
    tgjs,
    pinClicksOn(id) {
      // Two clicks on the element, 0.25 s and 0.6 s old at the pinned time.
      const r = $(id).getBoundingClientRect()
      const x = window.scrollX + r.left + r.width * 0.45
      const y = window.scrollY + r.top + r.height * 0.5
      fx.__override({
        time: 1.25,
        elapsed: 1.25,
        pointer: {
          x: 640,
          y: 450,
          follow: { x: 640, y: 450 },
          clicks: [
            { x, y, t: 1.0 },
            { x: x + 40, y: y - 30, t: 0.65 }
          ]
        }
      })
    },
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
