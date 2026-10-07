# `compositor-gpu/fx` — authoring contract

The effects layer of `docs/EFFECTS.md`. Built: the runtime spine and
fullscreen post (M1: `createEffects`, Params, the pointer, `fx.pass`) and
geometry (M2: Targets, Layers, region passes) and Materials (M3), with
the presets `blur`, `displace`, `cursorGlow`, `clickRipple` and `ripple`.
M3b added the Layer `simulate` compute hook, Layers that draw a Target's
glyphs or sample its image, `raw` materials, and TypeGPU externals for
JS-bodied (`'use gpu'`) hooks.

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

With `image: target`, every stage of the pass can sample that element's
image record (bind group 3):

```wgsl
fn image(uv : vec2f) -> vec4f               // premultiplied, uv 0..1, y down
fn image_level(uv : vec2f, lod : f32) -> vec4f  // lod > 0 can bleed
fn image_size() -> vec2f                    // texels; 0 until decoded
```

The whole image (not the `object-fit` crop), transparent until it
decodes; it is resolved when the stage draws, so atlas changes are
followed.

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
t.image                              // { width, height } | null
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
glyphs in a different space than the element are left out. `image` is
the texel size of the element's own image record (an `<img>`, canvas,
video, or its first background image) as the mirror drew it, or null
when it has none or it hasn't decoded yet; a Layer samples it with
`image: target`. Reading a Target reads no DOM.

## Layers

```ts
fx.layer({
  name: 'dots',
  count: 64, stride: 4,              // data is count × stride floats
  data?: Float32Array,
  space?: 'doc' | 'viewport',        // default 'doc' (page CSS px)
  place?: 'above' | 'below' | { after: target | element },
  vertex: hook, fragment: hook,      // WGSL or tgpu.fn (see TypeGPU)
  simulate?: hook,                   // compute step, see below
  image?: target | element,          // sample its image: image(uv)
  glyphs?: target | element,         // draw its glyphs: glyph_*(k, ...)
  params?: { ...schema },
  enabled?: true, continuous?: false,
  update?: (layer, time, ctx) => void   // every frame while enabled
}) -> Layer { name, params, data, count, stride, place, enabled,
              continuous, steps, markDirty(first?, n?), destroy() }
```

Instanced quads in the scene's paint order. Write `layer.data` (it grows
when `count` does) and call `markDirty()` (or `markDirty(first, n)` for
instances `[first, first + n)`); the marked instances are uploaded on
the next frame, and instances added by growing `count` are marked. Inside `update` the frame is already running, so
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
  dt       : f32,         // 32  s since the previous frame (<= 1/15)
  steps    : f32,         // 36  simulate steps run since enabled
  image_uv : vec4f,       // 48  runtime (image)
  image_size : vec2f,     // 64  the image's texel size, 0 until decoded
  glyph_count : f32,      // 72  runtime (glyphs)
  _pad     : f32,
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

**`simulate`** (`fn simulate(i : u32)`) runs in a compute pass for every
instance, each frame while the layer is enabled, before it draws. It
reads with `data*` and writes with `set_data(i, k, v)` / `set_data2` /
`set_data4`, so the state lives on the GPU: `layer.data` only seeds it,
and `markDirty` overwrites the marked instances' GPU state with their
`data` (other instances keep theirs). The state survives disabling;
growing `count` carries it over and seeds the new instances. Step with
`fx.dt`. `fx`, `params` and `pointer` are in scope as for the draw
hooks (`viewport_to_page`/`page_to_viewport` too, not `Frame`). A
layer with `simulate` defaults to `continuous: true`. `layer.steps`
counts dispatches since it was last enabled.

**`image: target`** binds the element's image record:

```wgsl
fn image(uv : vec2f) -> vec4f               // premultiplied, uv 0..1, y down
fn image_level(uv : vec2f, lod : f32) -> vec4f  // lod > 0 can bleed
                                                // across atlas neighbours
```

The whole image (its texels, not the `object-fit` crop). Transparent
until it decodes; atlas and texture changes are followed.

**`glyphs: target`** binds the element's mirrored glyphs (the same set
and order as `target.glyphs`), drawn with Slug's coverage:

```wgsl
fn glyph_count() -> u32
fn glyph_point(k : u32, uv : vec2f) -> vec2f  // ink box point, layer space
fn glyph_size(k : u32) -> vec2f               // ink box, local CSS px
fn glyph_color(k : u32) -> vec4f              // straight alpha
fn glyph_clip(k : u32) -> vec4f               // min.xy max.zw, layer space
fn glyph_coverage(k : u32, uv : vec2f) -> f32
```

`uv` spans the glyph's ink box (0..1, y down). `glyph_point` applies the
glyph's transform and `onGlyph` offset. `glyph_coverage` anti-aliases
from `uv`'s screen derivatives, so call it in uniform control flow (not
after a non-uniform `return` or `discard`); it is 0 for glyphs Slug
doesn't draw (emoji and other fallback-atlas glyphs) and for k out of
range. The clip is not applied: discard outside `glyph_clip(k)` to
clip. Ligatures draw on their first component (the others are empty).
To replace the mirrored text, pair the layer with a material on the
same target whose fragment returns `vec4f(0.0)`.

## Materials

```ts
fx.material({
  name: 'wave',
  target: el | target,             // its subtree's records are re-shaded
  kinds?: ['box', 'image', 'glyph'],  // default all three
  vertex?: hook, fragment?: hook,   // either or both (WGSL or tgpu.fn)
  raw?: { box?, image?, glyph?: wgsl },  // complete programs, see below
  params?: { ...schema },
  subdivisions?: 1,                 // n × n cells per quad, for bending
  hideSource?: !!(vertex || raw),   // hide the element's DOM paint
  hold?: false,                     // don't draw until compiled
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
                     // (mat_index(record) for a stable glyph index)
  kind     : u32,    // 0 box, 1 image, 2 glyph
};
fn mat_sample(delta : vec2f) -> vec4f  // images: the source delta CSS px
                                       // away (premultiplied, unclipped);
                                       // zero for boxes and glyphs
fn mat_index(record : u32) -> u32      // glyphs: the glyph's index in the
                                       // target (target.glyphs order);
                                       // boxes, images: record
```

`mat_index` makes per-letter staggers possible: it is stable across
re-reads while the text is unchanged, counts the target's glyphs in DOM
order (a ligature takes its first component's index; a fixed
descendant's glyphs are counted too, which `target.glyphs` leaves out,
so past one the two indices differ) and
works in both hooks; `fx.glyphs` is the count (`mat_index` runs from 0
to `fx.glyphs - 1`). Turning a glyph material
on or off re-uploads the text once.

`vertex` returns the displaced position of a corner in the same local
box; `local`/`uv` in `fragment` stay undisplaced, so the content moves
with the quad. With `subdivisions: n` the quad is n × n cells, which a
vertex hook can bend. Also in scope: `fx : MaterialFx` (time, elapsed,
dpr, glyphs (the glyphs `mat_index` numbers), scroll,
viewport in CSS px), `params`, `pointer`.

The pipeline compiles asynchronously the first time the records are
drawn; until then (and for good if the WGSL fails, with the error in the
console under `fx:<name>:<kind>`) they draw as usual, or, with `hold`,
not at all until it has compiled (for materials that start hidden). Text: Slug glyphs
and their hard shadows take the material, fallback-atlas glyphs (emoji,
missing code points) don't. A vertex hook moves geometry away from where
the DOM paints it, so by default the target's own DOM paint is hidden
while the material is enabled (`opacity: 0`, as replace mode does).

**`raw`** is for what the hooks can't express. Per kind, WGSL defining
both entry points against that pass's own declarations:

```wgsl
@vertex
fn vs(@builtin(vertex_index) vi : u32,
      @builtin(instance_index) ii : u32) -> VOut
@fragment
fn fs(in : VOut) -> @location(0) vec4f
```

It is compiled after the pass's material variant, whose entry points
become plain functions `default_vs(vi, ii)` and `default_fs(in)` (the
hooks, identity unless `vertex`/`fragment` are given too, still run
inside them). `VOut`, the instance struct and bind group 1 are the
pass's internals (`boxes/boxRenderer.ts`, `images/imageRenderer.ts`,
`text/slug/shaders.ts`) and can change between versions; bind group 2 is
the material's as for hooks. `kinds` defaults to the keys of `raw`. Draw
with `6·n²` vertices per instance and premultiplied-over blending, as
the pass does.

## Transforms

```ts
const t = fx.transform(el, {          // el: Element or Target
  x, y,                                // CSS px, default 0
  scale, scaleX, scaleY,               // default 1 (scale sets both)
  rotate,                              // degrees, clockwise
  opacity,                             // multiplies the element's own
  originX, originY,                    // fractions of the border box, 0.5
  enabled = true,
  fallback = 'dom'                     // without WebGPU: 'dom' | 'none'
}) -> Transform { ...those fields, el, gpu, enabled, destroy() }
```

Moves, scales, rotates and fades the element's mirrored subtree on the
GPU; the DOM is never written, so nothing is re-read and the page's
layout and hit-testing stay where they are (as with a browser compositor
layer). The fields are plain numbers: write them, or let GSAP tween them
(`gsap.from(t, { scale: 0.85, y: 40, opacity: 0, stagger: 0.08 })`).
Each write schedules a frame. CSS order: translate, rotate, then scale,
about the origin.

- While enabled the element is isolated (a stacking context, as with
  region passes). At rest (identity, opacity 1) its records draw in
  place, pixel-identical to no transform; otherwise its subtree renders
  to its own texture each frame and is drawn back through the transform.
  The texture covers only the part that can land on screen (inside the
  ancestors' clip). An enclosing group (opacity, region pass, another
  transform) grows its own texture to where transformed descendants land.
- Mid-animation the subtree is a resampled bitmap (text included), so
  scaling above 1 softens it; scaling down stays clean.
- The result is clipped by the element's ancestors' clips (their AABB:
  rounded or rotated clips are not followed).
- Toggling `enabled` (and creating or destroying one) isolates or
  releases the element, which schedules a full read; changing the
  numbers doesn't.
- A region pass on the same element takes precedence.
- Inert runtime (no WebGPU): with `fallback: 'dom'` each write sets the
  element's inline `transform` (before its computed transform),
  `transform-origin` and `opacity` (times its computed opacity); at
  rest, when disabled and on `destroy()` its own inline values come
  back. One animation drives both paths. With `transform-origin` changed,
  an existing transform composes about the new origin.

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
`continuous: false` to opt out. For tgpu.fn layer and material hooks the
resolved WGSL is inspected (so `gpu.time` counts); a tgpu.fn pass
fragment isn't, and on an inert runtime only WGSL strings are. `displace`
defaults to `continuous: true` (its noise drifts); `blur` is static;
`clickRipple` and `ripple` switch it on only while a ripple runs.

`time` is the page clock and `elapsed` restarts at 0 on the first frame
after a pass is enabled; both come from the frame's rAF timestamp, so
tween time scales affect params, not time.

## TypeGPU

Every hook takes a `tgpu.fn` with the hook's signature in place of WGSL:

| hook | signature |
| --- | --- |
| pass `fragment` | `([d.vec2f, d.texture2d(d.f32), d.sampler()], d.vec4f)` |
| material `vertex` | `([d.vec2f, d.vec2f, d.vec2f, d.u32], d.vec2f)` |
| material `fragment` | `([MatIn], d.vec4f)` |
| layer `vertex` | `([d.u32, d.vec2f], Quad)` |
| layer `fragment` | `([Quad, d.u32], d.vec4f)` |
| layer `simulate` | `([d.u32])` |

`MatIn` and `Quad` are exported `d.struct`s with the WGSL structs'
fields. The runtime resolves a primitive's tgpu.fn hooks in one
`tgpu.resolve` (`names: 'random'`, so TypeGPU's identifiers get
suffixes and can't clash with the module's own) behind wrappers that
call them, so shared dependencies are emitted once.

- **WGSL-bodied** (`tgpu.fn(...)(\`(uv, src, smp) { ... }\`)`): the body
  is pasted as written, so it can use the module's declarations
  (`sample`, `fx`, `params`, `pointer`, `data`, ...) directly.
- **JS-bodied** (`'use gpu'`) functions need `unplugin-typegpu` in the
  author's bundler (without it `tgpu.resolve` throws "Missing metadata",
  logged as `fx:<name>: tgpu.resolve failed`). They reach the module's
  declarations through `gpu`:

```ts
import { gpu, MatIn } from 'compositor-gpu/fx'
const p = gpu.params(schema)     // p.strength.$ : typed, per schema
gpu.time.$ / gpu.elapsed.$ / gpu.dpr.$
gpu.pointer.pos.$ / .page / .vel / .follow / .followVel / .down /
  .seen / .clicksN, gpu.pointer.click(k)
gpu.pass.sample(uv) / viewportToUv(p) / pageToUv(p) / image(uv) /
  imageLevel(uv, lod) / imageSize() (with `image`)
gpu.layer.data(i, k) / data2 / data4 / setData / setData2 / setData4
  (simulate) / image(uv) / glyphCount() / glyphPoint(k, uv) /
  glyphSize(k) / glyphColor(k) / glyphClip(k) / glyphCoverage(k, uv) /
  count.$ / dt.$ / steps.$ / scroll.$ / viewport.$
gpu.material.sample(delta) / index(record) / glyphs.$
```

Each stands for a declaration that only exists in that kind of shader
(`gpu.pass.sample` in a pass, `gpu.layer.setData` in `simulate`, ...);
used elsewhere the module fails to compile, which is logged. A
signature mismatch or failed resolve is logged and the hook falls back
(a pass stage passes through, a material keeps the identity hook, a
layer draws nothing).

## Presets

- `blur(fx, { radius = 8, region? })`: separable Gaussian, two stages,
  param `radius` (CSS px reach, σ = radius / 3, ≤ 32 taps per side,
  spread past that); declares `radius` as its sampling radius.
- `progressiveBlur(fx, { radius = 16, edges = [0, 1, 1, 1], width =
  [0.25, 0.4], corners = 1, curve = 1.5, region? })`: the same Gaussian
  with a radius that grows toward the weighted edges (top, right,
  bottom, left) over `width` (uv fraction, x then y). `corners` blends
  the union of the side and top/bottom ramps (0: bands) toward their
  product (1: corners only). Amount^`curve` × `radius`; ≤ 24 taps per
  side; each axis uses the radius at the pixel it writes.
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
- `dissolve(fx, target, { progress = 0, scale = 40, softness = 0.1,
  direction = [0, 1], sweep = 0.35, edge = 0, edgeColor = '#fff', hold
  = true })`: a Material over all kinds that shows each pixel once
  `progress` passes its threshold: value noise (feature size `scale` CSS
  px, fixed to the page) mixed by `sweep` with a ramp across the
  target's box along `direction`. `softness` is the fade width and
  `edge` a rim in `edgeColor` at the front, in threshold units. Hides
  the target's DOM paint while enabled; progress 1 draws as without it.
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
`fx.__override({ time?, elapsed?, dt?, pointer?: { x, y, down, follow,
clicks } })` pins those inputs (`dt` is every layer's `fx.dt`) (velocities read as zero; the follower
doesn't keep the loop alive); `null` clears it. Used by `test/fx/run.ts`;
not for production code.
