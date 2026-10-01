# Effects layer (`compositor-gpu/fx`)

Design spec, settled 2026-10-01. `ARCHITECTURE.md` describes the mirror;
this file describes the layer that applies GPU effects to it. The spec is
the target; `ROADMAP.md` tracks what is built.

## Premise

The mirror is the scene: every box, image plane and glyph on the page, in
document space, kept in step with the DOM. The effects layer consumes that
scene — post-processes it, re-shades parts of it, adds geometry around it —
and is otherwise independent of the DOM:

- An effect is never expressed in CSS and never reads computed style. DOM
  elements are *handles* for finding geometry, nothing more.
- Effects are plain JS objects driven by plain numeric parameters, so any
  animation library (gsap, motion, a rAF loop) drives them without an
  adapter. Hover and other interaction come from element events in JS, not
  from `:hover` state.
- An effect must be able to run with no DOM reference at all (cursor and
  click effects, fullscreen post). The mirror is the default geometry and
  texture provider, not a requirement.
- With no WebGPU the compositor is inert and so is `fx`: every call
  succeeds, nothing GPU-side renders, authoring code has no branches.

## Entry point

```ts
import { createCompositor } from 'compositor-gpu'
import { createEffects } from 'compositor-gpu/fx'

const compositor = await createCompositor({ mode: 'overlay' })
const fx = createEffects(compositor)
// fx.pass(...)  fx.material(...)  fx.layer(...)  fx.target(el)  fx.pointer
```

`/fx` is a second entry point of the same package. The core stays
dependency-light and exposes the few extension points the runtime needs
(below); everything author-facing lives in `/fx`. Same repo, harness and
version.

## Primitives

Three primitives, mechanically different on the GPU, sharing one parameter
model and the frame context.

### Pass — post-processing

Reads a rendered texture, writes a texture. One fragment function of
`uv`, the source texture and `Params`.

- **Fullscreen**: runs on the rendered scene, as a ping-pong chain in
  declaration order. "Fullscreen" means the *visible viewport*: the canvas
  scrolls with the document and is up to three viewports tall, so the
  chain is scissored to the visible rect plus the pass's declared
  sampling `radius` (a blur needs neighbours).
- **Region** (`region: Target`): affects only that element's pixels and
  respects stacking. Built on the isolated-group machinery: while the pass
  is active the element's subtree renders to its own texture and the
  composite step runs the pass's shader. Consequence, accepted: the subtree
  blends with its background as one unit while the pass is active.
- Post sees mirrored content only. Chrome lifted above the canvas with
  `zIndex` (see `data-gpu-ignore`) is untouched by construction; to include
  it, mirror it.
- The offscreen path (scene → texture → chain → canvas) engages only while
  at least one Pass is enabled. Otherwise the direct-to-swapchain path
  stays and installing `/fx` costs nothing.

### Material — re-shading mirrored records

Replaces how selected records draw, attached to a `Target`. The author
writes WGSL *functions* against a small contract per record kind; the pass
assembles the program around them so anti-aliasing, clipping, premultiplied
blending, stacking and the storage-buffer plumbing stay correct:

- a vertex hook returning a displaced position in the record's local
  space (optionally extra varyings);
- a fragment hook returning premultiplied colour given coverage (Slug
  coverage for glyphs, SDF distance for boxes), base colour, `uv`, a
  `sample(uv)` function for images, time and `Params`.

`raw: true` supplies a complete vertex+fragment program against the same
bind groups for the cases the contract can't express. Images accept
`subdivisions` so a plane can bend without a mesh API.

Mechanics: one pipeline per Material; draw batches are additionally cut by
material id so `draw(first, count)` runs the right pipeline per range. The
record's instance data is untouched, so disabling a Material is free.

A Material that displaces geometry uncovers the real DOM in overlay mode.
While such a Material is active, the runtime hides that Target's DOM paint
(`HIDDEN_ATTR`, as replace mode does per element), so the page can stay in
overlay mode and only effected elements hand their pixels to the GPU.
Hit-testing stays on the DOM at its layout position.

Per-letter staggers through the glyph contract are deferred; the first
contract exposes coverage, uv, local position and base colour only.

### Layer — free geometry

Geometry with no DOM counterpart: cursor trails, click ripples, particles
seeded from glyph positions, decoration. A Layer is instanced quads:

```ts
fx.layer({
  count, stride,              // author-owned Float32Array, N × stride
  data: new Float32Array(...),
  space: 'doc' | 'viewport',
  place: 'above' | 'below' | { after: target },
  vertex, fragment, params
})
```

The vertex hook positions a quad from the instance's floats; the fragment
hook shades it (SDF, sprite, or a glyph via Slug when it references a glyph
id). The author updates the array (directly or by tween) and marks it
dirty; the runtime uploads the used prefix. Reserved: a `simulate` compute
hook so particle state can live on the GPU.

### Params

Every primitive declares a schema and exposes a plain object:

```ts
params: {
  strength: { type: 'f32', default: 0, min: 0, max: 1 },
  tint:     { type: 'color', default: '#ffffff' },   // exposed as [r,g,b,a]
  center:   { type: 'vec2',  default: [0.5, 0.5] }
}
gsap.to(effect.params, { strength: 1, duration: 0.6 })
```

Colours and vectors are arrays of floats so component-wise tweens work.
The object is a `Proxy`: a write marks the effect dirty and requests a
frame. The schema generates the WGSL `struct Params` so names line up, and
is enough for a debug panel later.

Frame loop rule: a frame is requested on any param write, on any Layer
data dirty-mark, and continuously while any effect declares
`continuous: true` (followers, simulations, time-based motion). Otherwise
the loop idles as it does today.

Time: `time` is the global page clock; `elapsed` is per effect, reset when
the effect is enabled. Both come from the frame, so a tween's `timeScale`
affects params, not time.

## Targets — reaching the mirror's geometry

```ts
const t = fx.target(img)       // one element
const ts = fx.targets('section img')
t.rect / t.local / t.xform / t.space / t.radius   // live, re-resolved after each read
t.image                        // texture or atlas region, for image elements
t.glyphs                       // { count, rects: Float32Array, ids, text }
```

Identity is the DOM element, which is what authoring code and animation
libraries already select. The scene is rebuilt on reads and record ids
change; a Target re-resolves its records after every read. Glyphs carry a
stable index within their element so a tween can address "glyph 7 of this
heading" across re-reads. A Target is one element and its own records;
grouping is a Layer or Pass concern. Querying scene records directly stays
internal.

## Pointer

Provided by the runtime, not each author, as a uniform available to every
shader and as JS state:

- raw position (page and viewport), velocity, down state;
- an eased follower (position + velocity) with the ease factor as a param;
- a ring buffer of recent clicks `(x, y, t)` so a ripple needs no event
  code.

## Modes

Post and Layers work in overlay and replace mode. Displacing Materials
hide their Target's DOM paint (above). Hit-testing is always the DOM's.

## Authoring surface

Shader hooks are WGSL template strings against the documented contract, or
TypeGPU functions (`tgpu.fn`) with the same signatures — TypeGPU is a
first-class path, not a requirement. `reportShaderErrors` surfaces compile
errors under the effect's name at creation.

`/fx/presets` ships worked examples, not a catalogue: `blur`, `displace`
(noise- or texture-driven), `clickRipple` (Layer fed by the click buffer),
`cursorGlow` (Layer on the eased pointer), `ripple` (image Material). An
agent-facing instructions file accompanies them.

## Core extension points

The architectural change to the core is small and explicit; `/fx` uses
only these:

1. a render-graph hook to insert the offscreen scene target and run the
   Pass chain before the canvas composite;
2. a per-record `material` id the batch builder cuts on and the passes
   dispatch on;
3. registration of extra passes (Layers) with a paint-order position;
4. the frame context (time, pointer block, viewport/canvas region) and
   `Shared` (device, format, frame layout) exported for pipelines.

## Testing

- Invariants on the existing harness sections: with `/fx` installed and no
  effect enabled, output is pixel-identical to the plain mirror; enabling
  then disabling an effect returns to identical (no leaked state, offscreen
  path torn down).
- `playground/fx.html`, one section per preset, time/elapsed/pointer driven
  from fixed values by the harness, gated against local goldens.
- Perf: frame encode with a fullscreen blur Pass active at the viewport
  scissor, next to the idle number.

## Milestones

- **M1 — runtime spine + post.** Extension points 1 and 4; `/fx` entry and
  inert path; Params; pointer; fullscreen Pass (strings and `tgpu.fn`);
  presets `blur`, `displace`; `fx.html`, invariants, perf number.
- **M2 — geometry.** Target (with glyph arrays); Layer; presets
  `clickRipple`, `cursorGlow`; region Pass on isolated groups; extension
  point 3.
- **M3 — materials.** Material contract for glyph/image/box; extension
  point 2; per-Target DOM hiding; `ripple`; `subdivisions`; Layer compute
  hook.

## Deviations (M1 implementation)

Where the built M1 differs from the text above. `src/fx/README.md` is the
contract as built.

- **Core surface.** The extension points are one public field,
  `Compositor.graph: RenderGraph | null` (`src/gpu/graph.ts`):
  `setPostChain(chain)`, `addHook({ beforeFrame, keepAlive })`,
  `requestFrame()`, `shared`. The chain has two calls: `encode(frame)`
  records every stage but the last into its own ping-pong targets, and
  `composite(rp, frame)` draws the last stage into the canvas pass, after
  the core has copied the scene texture through and set the scissor. The
  core, not `/fx`, owns the copy-through.
- **Scissor.** The chain writes the visible viewport grown by the max
  radius, not just the viewport, so that margin holds effect output too
  (it shows for a frame when the page scrolls before the next render).
- **Multi-stage passes.** `fragment` may be an array; each entry is a stage
  run on the previous one's output, sharing the pass's Params. The `blur`
  preset's two axes are one Pass this way. `radius` may be a function of
  the params.
- **Pointer is `/fx`'s.** The core doesn't track the pointer:
  `FrameContext.pointer` is null unless `/fx` is installed, which fills it
  from a frame hook. The follower advances on compositor frames only;
  pointer events request frames, and the follower keeps the loop alive,
  only while some pass is enabled, so an installed `/fx` with nothing
  enabled never wakes the loop.
- **Wake on param writes** happens only for enabled passes (a disabled
  pass has nothing to show; its dirty block uploads when it next runs).
- **Units.** `Effect.time`/`elapsed` are seconds (`Frame.time` stays ms).
  Click `t` is `performance.now() / 1000`, the same clock. `min`/`max`
  in a Params schema are metadata; writes are not clamped.
- **TypeGPU.** WGSL-bodied `tgpu.fn` fragments work (resolved with
  `tgpu.resolve`, body pasted as written, so it can call `sample` and read
  `params`). JS-bodied (`'use gpu'`) ones need `unplugin-typegpu` in the
  author's build and still can't reach `sample`/`params`/`pointer`, which
  are WGSL declarations rather than TypeGPU values. Open for M2.
- **Types.** `vite-plugin-dts`'s `rollupTypes` emits per-file `.d.ts`
  (it already did before `/fx`: `@microsoft/api-extractor` isn't
  installed), so `exports['./fx'].types` is `dist/fx/index.d.ts`.
