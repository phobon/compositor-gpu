# `compositor-gpu/fx` — authoring contract

The effects layer of `docs/EFFECTS.md`. M1 ships the runtime spine and
fullscreen post: `createEffects`, Params, the pointer, `fx.pass`, and the
`blur` / `displace` presets. Targets, Layers and Materials are M2/M3.

```ts
import { createCompositor } from 'compositor-gpu'
import { blur, createEffects, displace } from 'compositor-gpu/fx'

const compositor = await createCompositor()
compositor.start()
const fx = createEffects(compositor)
const soft = blur(fx, { radius: 6 })
gsap.to(soft.params, { radius: 0, duration: 0.6 })
```

Importing `/fx` does nothing (safe on a server). On an inert compositor
(no WebGPU) `createEffects` returns an inert runtime: `fx.pass()` returns a
working Pass (params proxy, `enabled`, `radius`), nothing renders, no
listeners are attached, `fx.active` is false.

## Pass

```ts
fx.pass({
  name: 'tint',                    // labels pipelines and shader errors
  fragment: wgsl | tgpuFn | [ ... ],
  params?: { ...schema },          // see Params
  radius?: number | (params) => number,  // CSS px sampled past the viewport
  enabled?: true,
  continuous?: false
}) -> Pass { name, params, enabled, continuous, radius, destroy() }
```

- Passes run in creation order, each on the previous one's output. An
  array `fragment` is one Pass with several stages (sharing `params`), run
  in order; `blur` uses it for its two axes.
- "Fullscreen" is the **visible viewport**. The chain writes the viewport
  grown by the largest `radius` of the enabled passes (× dpr, clamped to
  the canvas); the rest of the canvas (it is up to three viewports tall)
  shows the scene unchanged. A pass that samples further than its declared
  radius reads clamped edge texels there.
- Everything is premultiplied: `sample()` returns premultiplied colour and
  `effect` must return premultiplied colour. It is written without blending
  (it replaces the pixel).
- While no pass is enabled the renderer draws straight to the swapchain;
  the offscreen scene texture and the ping-pong pair are released on the
  next frame. `destroy()` removes a pass and frees its buffers.

### Fragment signature

```wgsl
fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f
```

`uv` is [0,1]² over the visible viewport (y down); it goes outside that
range in the radius margin. `src`/`smp` are the raw source texture and its
linear clamp sampler; their coordinates are **not** `uv` (the source is the
whole-canvas scene or a ping-pong texture). Use `sample(uv)`, or
`textureSampleLevel(src, smp, src_uv(uv), 0.0)`.

### What the runtime puts in scope

The module is `FRAME_WGSL` + the declarations below + the Params struct +
your code + the entry points (`fx_vs`, `fx_fs`; avoid those names and the
`fx_` prefix).

```wgsl
struct Frame { viewport: vec2f, scroll: vec2f, time: f32, dpr: f32,
               vscroll: vec2f };           // core; canvas-sized
@group(0) @binding(0) var<uniform> frame : Frame;

struct Effect {          // offset
  time       : f32,      //  0  page clock, s (performance.now() / 1000)
  elapsed    : f32,      //  4  s since this pass was last enabled
  viewport   : vec2f,    //  8  visible viewport, device px
  texel      : vec2f,    // 16  one device px in uv (1 / viewport)
  scroll     : vec2f,    // 24  viewport's document-space origin, CSS px
  dpr        : f32,      // 32
  _pad       : f32,      // 36
  origin     : vec2f,    // 40  runtime-internal from here on
  src_origin : vec2f,    // 48
  src_size   : vec2f,    // 56
  dst_origin : vec2f,    // 64
  src_texel  : vec2f,    // 72
};                       // 80 bytes

@group(1) @binding(0) var fx_src : texture_2d<f32>;
@group(1) @binding(1) var fx_smp : sampler;
@group(2) @binding(0) var<uniform> fx      : Effect;
@group(2) @binding(1) var<uniform> params  : Params;
@group(2) @binding(2) var<uniform> pointer : Pointer;

fn sample(uv : vec2f) -> vec4f          // source at uv, premultiplied
fn src_uv(uv : vec2f) -> vec2f          // uv -> source texture coords
fn viewport_to_uv(p : vec2f) -> vec2f   // viewport CSS px -> uv
fn page_to_uv(p : vec2f) -> vec2f       // page CSS px -> uv
```

`sample` uses `textureSampleLevel(..., 0.0)`, so it is valid in
non-uniform control flow. A device-pixel step in uv is `fx.texel`; a CSS
pixel is `fx.texel * fx.dpr`.

Compile errors are reported by `reportShaderErrors` under `fx:<name>`
(`fx:<name>#<i>` for stage i > 0).

## Params

```ts
params: {
  strength: { type: 'f32',   default: 0, min: 0, max: 1 },
  center:   { type: 'vec2',  default: [0.5, 0.5] },
  axis:     { type: 'vec3',  default: [0, 0, 1] },
  rect:     { type: 'vec4',  default: [0, 0, 1, 1] },
  tint:     { type: 'color', default: '#ffffff' }
}
```

`pass.params` is a `Proxy`: `f32` reads as a number, the rest as arrays of
floats. A colour is `[r, g, b, a]`, sRGB-encoded and unpremultiplied
(like the rest of the library); it accepts `'#rgb[a]'`, `'#rrggbb[aa]'`,
`[r,g,b]` or `[r,g,b,a]` on assignment. Assigning an array copies into the
existing one, and element writes (`params.tint[3] = 0.5`) count as writes,
so component-wise tweens work. `min`/`max` are metadata for UIs; writes are
not clamped. Other keys (a tween library's cache) are stored and ignored.

A write that changes a value marks the pass dirty (re-uploaded on the next
frame it runs) and requests a frame if the pass is enabled.

The schema becomes, in declaration order,

```wgsl
struct Params { strength : f32, center : vec2f, axis : vec3f,
                rect : vec4f, tint : vec4f };
```

packed with WGSL uniform alignment (f32 4, vec2f 8, vec3f 16 with size 12,
vec4f 16; an f32 can follow a vec3f in its last 4 bytes), the block padded
to a multiple of 16 bytes. An empty schema declares `_unused : f32`. Names
must be WGSL identifiers starting with a letter.

## Pointer

Tracked from passive `window` listeners (`pointermove`, `pointerdown`,
`pointerup`, `pointercancel`, `blur`). JS: `fx.pointer` (also
`FrameContext.pointer` in `onFrame` while `/fx` is installed):

```ts
{ x, y,            // viewport CSS px
  pageX, pageY,    // page CSS px
  vx, vy,          // CSS px/s, exponentially smoothed (τ = 50 ms)
  down, seen,
  follow: { x, y, vx, vy },   // eased follower, viewport CSS px
  ease,            // per 60 Hz frame, default 0.12, writable
  clicks }         // last 8 { x, y (page CSS px), t (s, page clock) }, newest first
```

The follower moves `1 - (1 - ease)^(dt·60)` of the way per frame, so its
speed doesn't depend on the frame rate. It advances on compositor frames.

```wgsl
struct Pointer {           // offset
  pos        : vec2f,      //   0  raw, viewport CSS px
  page       : vec2f,      //   8  raw, page CSS px
  vel        : vec2f,      //  16  CSS px/s
  follow     : vec2f,      //  24  follower, viewport CSS px
  follow_vel : vec2f,      //  32
  down       : f32,        //  40  1 while down
  seen       : f32,        //  44  1 after the first event
  clicks_n   : f32,        //  48  valid entries in clicks
  _pad       : f32,
  _pad2      : vec2f,
  clicks     : array<vec4f, 8>,   // 64  (x, y page CSS px, t s, 0), newest first
};                         // 192 bytes
```

Click age is `fx.time - pointer.clicks[i].z`.

## Wake rules

The compositor idles unless something asks for frames. `/fx` requests one
on: a param write to an enabled pass; `enabled` toggling; `continuous`
changing; pass creation (enabled) and destruction; a pointer event while
any pass is enabled. It keeps the loop alive while any enabled pass is
`continuous`, or while any pass is enabled and the pointer follower is
more than 0.1 px from the pointer (or velocity hasn't decayed below
1 px/s). `displace` defaults to `continuous: true` (its noise drifts);
`blur` is static.

`time` is the page clock and `elapsed` restarts at 0 on the first frame
after a pass is enabled; both come from the frame's rAF timestamp, so
tween time scales affect params, not time.

## TypeGPU fragments

A `tgpu.fn([d.vec2f, d.texture2d(d.f32), d.sampler()], d.vec4f)` is
accepted wherever a WGSL string is. The runtime resolves it with
`tgpu.resolve({ template, externals: { fx_user: fn } })` behind a wrapper
`fn effect(...) { return fx_user(uv, src, smp); }`, so the function and
its own TypeGPU dependencies are emitted with TypeGPU's naming. What works
in 0.12:

- **WGSL-bodied** `tgpu.fn(...)(\`(uv, src, smp) { ... }\`)`: works. The
  body is pasted as written, so it can call `sample`, read `fx`, `params`
  and `pointer`, and use any `$uses` externals.
- **JS-bodied** (`'use gpu'`) functions need `unplugin-typegpu` in the
  author's bundler; without it `tgpu.resolve` throws "Missing metadata",
  which is logged as `fx:<name>: tgpu.resolve failed` and the stage passes
  the source through. With the plugin, they can't yet reach `sample`,
  `params`, `fx` or `pointer`: those are WGSL declarations, not TypeGPU
  values. TODO: expose them as TypeGPU externals (a `d.struct` generated
  from the Params schema, `tgpu.fn` wrappers for the helpers) so JS bodies
  can call them.

A signature mismatch is logged and the stage passes through.

## Presets

- `blur(fx, { radius = 8 })`: separable Gaussian, two stages, param
  `radius` (CSS px reach, σ = radius / 3, ≤ 32 taps per side, spread past
  that); declares `radius` as its sampling radius.
- `displace(fx, { strength = 6, scale = 80, speed = 0.3, pointerStrength
  = 0, pointerRadius = 160 })`: samples `strength` CSS px away along a
  value-noise vector of feature size `scale`, drifting at `speed`; with
  `pointerStrength > 0` it also magnifies the scene around
  `pointer.follow` within `pointerRadius` (shift = distance × falloff ×
  pointerStrength / pointerRadius, peaking near 0.26 × pointerStrength).
  Declares `strength + pointerStrength` as its radius. `continuous` by default.

## Testing hook

`fx.__override({ time?, elapsed?, pointer?: { x, y, down, follow,
clicks } })` pins those inputs (velocities read as zero; the follower
doesn't keep the loop alive); `null` clears it. Used by `test/fx/run.ts`;
not for production code.
