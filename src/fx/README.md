# `compositor-gpu/fx` — authoring contract

The effects layer of `docs/EFFECTS.md`. Built: the runtime spine and
fullscreen post (M1: `createEffects`, Params, the pointer, `fx.pass`) and
geometry (M2: Targets, Layers, region passes) and Materials (M3), with
the presets `blur`, `displace`, `cursorGlow`, `clickRipple` and `ripple`.
Still to come (M3b): a Layer compute hook, Slug glyphs in Layers,
`Target.image`, `raw` materials, TypeGPU externals.

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
working Pass (params proxy, `enabled`, `radius`), `fx.layer()` a Layer
with its `data` array, `fx.target()` a Target that is never `found`;
nothing renders, no listeners are attached, `fx.active` is false.

## Pass

```ts
fx.pass({
  name: 'tint',                    // labels pipelines and shader errors
  fragment: wgsl | tgpuFn | [ ... ],
  params?: { ...schema },          // see Params
  radius?: number | (params) => number,  // CSS px sampled past the viewport
  enabled?: true,
  continuous?: false,
  region?: target | element         // see Region passes
}) -> Pass { name, params, enabled, continuous, radius, region, destroy() }
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

### Region passes

With `region`, the pass applies to one element and is not part of the
fullscreen chain. While it is enabled the element is isolated: its
subtree renders to its own texture (grown by the pass `radius` on every
side, so a blur spreads past the element), then the pass's stages run on
it and the last one is blended premultiplied-over onto what is under the
element, times the element's own opacity. Same fragment signature:

- `uv` spans the element's border box (its AABB under a transform) and
  goes outside [0,1]² in the radius margin; `fx.viewport` is that box in
  device px, `fx.scroll` its page position, so `page_to_uv` and
  `viewport_to_uv` map onto it.
- Isolation makes the element a stacking context (as `isolation:
  isolate` would). For an element that already is one (positioned,
  transformed, `opacity < 1`, ...) nothing changes; otherwise positioned
  descendants that interleaved with content outside it now paint with it.
- Toggling `enabled` isolates or releases the element, which schedules
  a full read. One region pass per element.

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
  page_scroll : vec2f,   // 80  the real document scroll
  alpha      : f32,      // 88  region: the element's opacity
  _pad2      : f32,      // 92
};                       // 96 bytes

@group(1) @binding(0) var fx_src : texture_2d<f32>;
@group(1) @binding(1) var fx_smp : sampler;
@group(2) @binding(0) var<uniform> fx      : Effect;
@group(2) @binding(1) var<uniform> params  : Params;
@group(2) @binding(2) var<uniform> pointer : Pointer;

fn sample(uv : vec2f) -> vec4f          // source at uv, premultiplied
fn src_uv(uv : vec2f) -> vec2f          // uv -> source texture coords
fn viewport_to_uv(p : vec2f) -> vec2f   // viewport CSS px -> uv (via page)
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

## Targets

```ts
const t = fx.target(el)              // cached per element
const ts = fx.targets('section img') // under document, or a root
t.found / t.rect / t.local / t.xform / t.space / t.radius / t.glyphs
t.version                            // changes when it re-resolves
```

A Target is a handle on the mirror's geometry for one element, resolved
lazily from the most recent read (again after every rebuild of the
scene). `rect` is the border-box AABB in `space` (`'viewport'` inside a
`position: fixed` subtree), `local`/`xform` the untransformed size and
local → space affine, `radius` the corner radii of its own box (zeros
when it paints none). `glyphs` = `{ count, rects (x, y, w, h per glyph,
Float32Array), ids (font glyph ids), text (grapheme per glyph) }` for the
subtree in DOM order, so index i is stable while the text is unchanged;
glyphs in a different space than the element are left out. Reading a
Target reads no DOM.

## Layers

```ts
fx.layer({
  name: 'dots',
  count: 64, stride: 4,              // data is count × stride floats
  data?: Float32Array,
  space?: 'doc' | 'viewport',        // default 'doc' (page CSS px)
  place?: 'above' | 'below' | { after: target | element },
  vertex: wgsl, fragment: wgsl,
  params?: { ...schema },
  enabled?: true, continuous?: false,
  update?: (layer, time, ctx) => void   // every frame while enabled
}) -> Layer { name, params, data, count, stride, place, enabled,
              continuous, markDirty(), destroy() }
```

Instanced quads in the scene's paint order. Write `layer.data` (it grows
when `count` does) and call `markDirty()`; the used prefix is uploaded
on the next frame. Inside `update` the frame is already running, so
writes there request no further frame: keep a layer animating with
`continuous` (set it from `update` if needed, as `clickRipple` does). Places:

- `'above'`: over every mirrored record (and under any fullscreen pass,
  which sees the layer).
- `'below'`: over the page background (the own boxes of the mirrored
  root, `<html>` and `<body>`), under all other content.
- `{ after: target }`: right after the element and its subtree: over it,
  under whatever paints after it. Inside an enclosing `opacity < 1`
  element the layer draws into that group (with its opacity) and is
  clipped to the group's bounds. A target with nothing in the mirror
  draws nothing. Assigning `layer.place` re-places it.

```wgsl
struct Quad { pos : vec2f, uv : vec2f, color : vec4f, extra : vec4f };
fn vertex(i : u32, corner : vec2f) -> Quad   // yours; corner in {0,1}²
fn fragment(q : Quad, i : u32) -> vec4f      // yours; premultiplied
```

`vertex` returns one corner of quad `i`: `pos` in CSS px in the layer's
space (the runtime maps it to clip space), the rest free; all four are
interpolated into `fragment`. Blending is premultiplied over. In scope:

```wgsl
struct LayerFx {          // offset
  time     : f32,         //  0  page clock, s
  elapsed  : f32,         //  4  s since enabled
  dpr      : f32,         //  8
  count    : f32,         // 12
  scroll   : vec2f,       // 16  real document scroll, CSS px
  viewport : vec2f,       // 24  CSS px
};
@group(1) @binding(1) var<uniform> fx      : LayerFx;
@group(1) @binding(2) var<uniform> params  : Params;
@group(1) @binding(3) var<uniform> pointer : Pointer;
fn data(i : u32, k : u32) -> f32     // also data2 / data4
fn viewport_to_page(p : vec2f) -> vec2f
fn page_to_viewport(p : vec2f) -> vec2f
```

plus `Frame`/`to_clip` from the core. Compile errors report under
`fx:<name>`.

## Materials

```ts
fx.material({
  name: 'wave',
  target: el | target,             // its subtree's records are re-shaded
  kinds?: ['box', 'image', 'glyph'],  // default all three
  vertex?: wgsl, fragment?: wgsl,   // either or both
  params?: { ...schema },
  subdivisions?: 1,                 // n × n cells per quad, for bending
  hideSource?: !!vertex,            // hide the element's DOM paint
  enabled?: true, continuous?: false,
  update?: (material, time, ctx) => void
}) -> Material { name, params, target, enabled, continuous, destroy() }
```

A Material swaps the hooks the record passes are built around: the
records keep their own anti-aliasing, clipping, blending and paint
order. Records of the target's subtree are tagged whenever batches are
built; a batch never mixes materials. Where two materials cover the same
record, the one created later wins.

```wgsl
fn vertex(local : vec2f, size : vec2f, uv : vec2f, record : u32) -> vec2f
fn fragment(m : MatIn) -> vec4f      // premultiplied

struct MatIn {
  color    : vec4f,  // what the record paints here, premultiplied
  local    : vec2f,  // fragment in the record's local box, CSS px
  size     : vec2f,  // that box (element box; glyph ink box)
  uv       : vec2f,  // local / size
  page     : vec2f,  // fragment in the record's space (page, or viewport
                     // for fixed content), CSS px
  coverage : f32,    // edge coverage (glyph outline, box edge, image clip)
  dist     : f32,    // box/image: rounded-box SDF, CSS px, < 0 inside
  record   : u32,    // instance index: varies per record, not stable
  kind     : u32,    // 0 box, 1 image, 2 glyph
};
fn mat_sample(delta : vec2f) -> vec4f  // images: the source delta CSS px
                                       // away (premultiplied, unclipped);
                                       // zero for boxes and glyphs
```

`vertex` returns the displaced position of a corner in the same local
box; `local`/`uv` in `fragment` stay undisplaced, so the content moves
with the quad. With `subdivisions: n` the quad is n × n cells, which a
vertex hook can bend. Also in scope: `fx : MaterialFx` (time, elapsed,
dpr, scroll, viewport in CSS px; same layout as `LayerFx` without
`count`), `params`, `pointer`.

The pipeline compiles asynchronously the first time the records are
drawn; until then (and for good if the WGSL fails, with the error in the
console under `fx:<name>:<kind>`) they draw as usual. Text: Slug glyphs
and their hard shadows take the material, fallback-atlas glyphs (emoji,
missing code points) don't. A vertex hook moves geometry away from where
the DOM paints it, so by default the target's own DOM paint is hidden
while the material is enabled (`opacity: 0`, as replace mode does).

## Wake rules

The compositor idles unless something asks for frames. `/fx` requests one
on: a param write to an enabled pass, layer or material; `enabled` toggling;
`continuous` changing; creation (enabled) and destruction; a layer's
`markDirty()` or `count` change; a pointer event while any pass, layer or
material is enabled; a material pipeline finishing its compile. It keeps
the loop alive while any enabled pass, layer or material is
`continuous`, or while anything is enabled and the pointer follower is
more than 0.1 px from the pointer (or velocity hasn't decayed below
1 px/s). `continuous` defaults to true when a WGSL hook (a pass
fragment, a layer's or material's vertex/fragment) reads `fx.time` or
`fx.elapsed`, so time-driven effects animate without input; pass
`continuous: false` to opt out (a `tgpu.fn` isn't inspected). `displace`
defaults to `continuous: true` (its noise drifts); `blur` is static;
`clickRipple` and `ripple` switch it on only while a ripple runs.

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
  values. Planned for M3: expose them as TypeGPU externals (a `d.struct`
  generated from the Params schema, `tgpu.fn` wrappers for the helpers)
  so JS bodies can call them.

A signature mismatch is logged and the stage passes through.

## Presets

- `blur(fx, { radius = 8, region? })`: separable Gaussian, two stages,
  param `radius` (CSS px reach, σ = radius / 3, ≤ 32 taps per side,
  spread past that); declares `radius` as its sampling radius.
- `displace(fx, { strength = 6, scale = 80, speed = 0.3, pointerStrength
  = 0, pointerRadius = 160, mode = 'lens', region? })`: samples
  `strength` CSS px away along a value-noise vector of feature size
  `scale`, drifting at `speed`; with `pointerStrength > 0` it also warps
  the scene around `pointer.follow` within `pointerRadius`. Param `mode`
  0 (`'lens'`) magnifies (shift = distance × falloff × pointerStrength /
  pointerRadius, peaking near 0.26 × pointerStrength); 1 (`'push'`)
  shoves content outward by pointerStrength × falloff, folding through
  the centre. Declares `strength + pointerStrength` as its radius.
  `continuous` by default.
- `cursorGlow(fx, { radius = 160, intensity = 0.35, color = '#fff',
  place = 'above' })`: one viewport-space quad on the eased follower, a
  radial falloff; `place: 'below'` lights up behind content.
- `ripple(fx, target, { amplitude = 8, wavelength = 24, speed = 360,
  duration = 1.2 })`: an image Material (fragment only, `mat_sample`): a
  wave packet travelling out from each recent click; `continuous` only
  while the newest one runs.
- `clickRipple(fx, { radius = 80, width = 2, duration = 0.6, color =
  '#fff', place = 'above' })`: a ring per entry of `pointer.clicks`
  (document space, so it stays where clicked), ease-out growth, linear
  fade; `continuous` only while the newest ripple runs.

## Testing hook

`fx.__pending()` counts material pipelines still compiling.
`fx.__override({ time?, elapsed?, pointer?: { x, y, down, follow,
clicks } })` pins those inputs (velocities read as zero; the follower
doesn't keep the loop alive); `null` clears it. Used by `test/fx/run.ts`;
not for production code.
