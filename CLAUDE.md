# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # vite dev server rooted at playground/ (opens a browser)
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + vite library build -> dist/ (+ rolled-up .d.ts)
npm run lint       # biome check src
npm run lint:fix   # biome check --write src
npm run format     # biome format --write .
```

There is no unit-test framework. Rendering is checked with the
**visual-regression harness**: `npm run test:visual` (Playwright + pixelmatch,
`test/visual/run.ts`) captures each `section[data-vr]` of the playground in
DOM-only and GPU-only mode and reports `parity` (DOM vs GPU mismatch %,
informational — Slug's glyph AA differs from the browser's, so text sections
sit around 3–5%) and `regression` (GPU capture vs a local golden, gating at
0.5%; `--update` rewrites goldens, which are GPU-specific and gitignored).
Headless WebGPU works: the harness tries the real GPU first and falls back to
SwiftShader (`--enable-unsafe-webgpu --enable-features=Vulkan
--use-angle=swiftshader --use-vulkan=swiftshader`), so it also runs in a
sandbox with no GPU. First run needs `npx playwright install chromium`. After
any shader / reader / sync change: run it, read the `*-parity-diff.png` files
in `test/visual/out/`, and describe what differs rather than claiming it
works. WGSL can also be validated offline with `naga` (`cargo install
naga-cli`) before a run.

**Performance harness**: `npm run test:perf` renders `playground/perf.html`
(400 cards, ~4.8k elements, ~84k glyphs) headless and reports full-read,
partial-read and frame-encode medians (`test/perf/out/last.json`);
`npx tsx test/perf/profile.ts` writes a CPU profile of five full reads to
`test/perf/out/profile.txt`. Baseline under SwiftShader: full read ~430 ms
(587 ms with a Range per grapheme, same session), partial read ~20–50 ms
(mostly the browser's own reflow), encode <1 ms; the run also prints
`stats().textRead`. Range reads are no longer the floor: `FAST_TEXT_READ`
cut them from 84k to ~15k per full read (profile: 1103 → 332 ms native
over five reads); what remains is 40 rotated cards (the split is off under
a transform), 16px titles (opsz mismatch, see Text), and computed-style
reads. Timings swing ±30% run to run in the sandbox (more when other
jobs share the machine), so compare A/B in the same session. That page draws in ~114 calls: the batch builder indexes
members in a 128px grid and tests text runs per glyph (a run's union rect
spans whole paragraphs and blocked every merge), and shadow records use a
1.5σ `batchRect` footprint.
`readMs` / `uploadMs` / `encodeMs` are in `stats()`. Don't call `window.scrollX`
in the reader — `beginRead()` snapshots it once per pass (`toDocRect`).

**Effects harness**: `npm run test:fx` (`test/fx/run.ts`, `-- --update`
to rewrite goldens, `-- --only <shot>`) loads `playground/fx.html?vr`,
pins time/elapsed/pointer through `fx.__override`, and captures each
section GPU-only against local goldens (`test/fx/golden/`, gate 0.5%, no
parity column): `fx-off`, `fx-tgpu` (a `tgpu.fn` fragment), `fx-blur`,
`fx-blur-scissor` (loop stopped, scrolled half a viewport: the canvas that
was off-viewport must be unblurred), `fx-displace`, `fx-blur-then-off`
(off → on → off; the last must equal the first exactly), `fx-displace-push`,
and on the geometry section `fx-geometry`, `fx-glow`, `fx-ripple`, `fx-after`,
`fx-region`, `fx-region-then-off` (must equal `fx-geometry` exactly). Console errors
from the library fail it. `npm run test:visual -- --with-fx` loads the
main playground with `/fx` installed and no pass enabled; it must match
the plain goldens at 0.00. The perf harness also reports `steady encode
(blur)`. Never run two harnesses at once (they time each other out), and
don't edit files under `src/`/`playground/` during a run: the dev server
reloads the page and the run dies.

**Site harness**: `npm run test:site -- --url <url>` (`test/site/run.ts`)
checks DOM-vs-GPU parity on an arbitrary real page instead of the playground.
It builds a self-contained ES bundle of `src/index.ts` (typegpu/opentype.js
bundled in, cached by `src/` mtime), injects it via a routed same-origin
script so a default `script-src 'self'` CSP still allows it, mounts a
compositor over `--root` (default `body`), and diffs DOM-only vs GPU-only
screenshots at each `--scroll` offset (default `0,600,1200`, clamped to page
height). With no `--url` it targets the playground's own `?vr` mode; against
a page that already mounts the library itself, `--bundle-url` skips injection
and expects `window.__site`. Console errors/warnings, uncaught exceptions,
and any `SlugText` faces that failed to resolve (CORS/404 on an `@font-face`
`url()`) are collected and printed in a final summary; parity is informational
unless `--parity-max` is passed.

Vite has two modes (`vite.config.ts`): `serve` roots at `playground/`, `build`
bundles two ES entries, `src/index.ts` → `dist/compositor-gpu.js` and
`src/fx/index.ts` → `dist/fx.js` (`compositor-gpu/fx`), with `typegpu` and
`opentype.js` external. `@/*` aliases `src/*` in both tsconfig and vite.

## Status

`docs/HANDOFF.md` is the session handoff for the bonobolabs.com `/duo`
integration: checkouts, uncommitted state, how to run the site and the
readout, and the first move on each open problem. Read it before touching
the site side.

`ROADMAP.md` is the live checklist, `docs/ARCHITECTURE.md` is the mirror's
spec and `docs/EFFECTS.md` the effects layer's (`compositor-gpu/fx`) — the
spec describes the target, not all of which is built. Currently real: the box
pass (a complete DOM→GPU vertical slice) and the Slug text pass (font pipeline +
WGSL, rendering but still being tuned). `ImagePass` renders `<img>`, `<canvas>`,
`<video>` and `background-image url()` with mipmaps and rounded clipping;
gradients live in the box pass. Read `ROADMAP.md` before assuming a feature is missing by accident.

**Effects layer** (`src/fx/`, `compositor-gpu/fx`): spec in
`docs/EFFECTS.md` (with Deviations sections for what M1 and M2 changed), author
contract in `src/fx/README.md`. M1 and M2 are built: `createEffects
(compositor)`, Params, the pointer, fullscreen and region `fx.pass`,
`fx.target`, `fx.layer`, presets `blur`/`displace`/`cursorGlow`/
`clickRipple`. Layers draw at `extra` entries of `scene.batches` (anchors
resolved by `Scene.anchors` at every batch build; `graph.addLayer`); a
region pass isolates its element (`graph.isolate` → `SceneReader.isolated`
→ a group with `region` set, composited by its `RegionHandler`). It
reaches the core only through `compositor.graph` (`gpu/graph.ts`): a
`PostChain` the renderer runs when `active()` (scene → offscreen texture
→ chain → canvas pass that copies the scene through and lets the last
stage overwrite the visible viewport + radius), and `FrameHook`s
(`beforeFrame` fills `FrameContext.pointer`; `keepAlive` holds the rAF
loop). With no enabled pass `render()` takes the direct path unchanged.

## Architecture

Data flows one way: **DOM → reader → Scene → RenderPass → canvas.** Observers
only set dirty flags; they never touch GPU state. One rAF drains them.

### Two coordinate spaces
Everything in `scene/records.ts` is in **document space** (CSS px from the
document's top-left: `getBoundingClientRect()` + `scrollX/Y`, via
`toDocRect`). `doc_to_clip()` in `gpu/frame.ts` maps that to clip space in the
vertex shader. This is the load-bearing decision: **scrolling writes one uniform
and re-reads nothing.** Never store viewport-relative coordinates in a
doc-space record, and never make scroll a reason to re-walk the DOM.

The canvas is `position: absolute` on `<html>`, so the browser scrolls it with
the page (no lag behind the DOM). It covers the viewport plus `canvasMargin`
(default one viewport height) above and below, clamped to the document's
scrollable size. Its document-space origin is the **anchor**: when the
viewport leaves the canvas (any horizontal scroll, or vertically past the
margin) or on resize, `frame()` moves it to `anchorY = clamp(scrollY - margin,
0, docH - canvasH)`, `anchorX = scrollX`, before `render()` in the same task.
`FrameContext.canvasX/Y/Width/Height` carry the canvas region;
`scrollX/Y`/`width/height` stay the real viewport. The Frame uniform's
`viewport`/`scroll` are the canvas size and anchor.

The one exception is `position: fixed` on the viewport: the reader walks
that subtree with `setReadSpace('viewport')` (no scroll offset in
`toDocRect`) and tags its records `space: 'viewport'`; every vertex shader
calls `to_clip(p, space)`, which subtracts `frame.scroll` (doc) or
`frame.vscroll` (viewport: the target origin minus the real scroll, i.e.
`anchor - scroll` on the canvas and `groupOrigin - scroll` on a group
target). Fixed content is drawn at its position at frame time and moves
with the page between frames. Clips and `ElNode.rect` are in the node's space, so the escalation
check is scroll-invariant for fixed subtrees. Opacity groups keep doc
`bounds` and viewport `vbounds`, unioned at the current scroll by the
renderer; the batch builder treats records of different spaces as always
overlapping. `position: sticky` stays doc-space: on scroll the compositor
re-reads, paint-only, each sticky element whose rect moved
(`SceneReader.movedStickies`).

Records also carry a **local frame**: `local` (untransformed layout size) and
`xform` (2×3 affine, local → document). `rect` stays the document-space AABB
(used by batching overlap tests and the partial-read escalation check);
shaders position quads with `xform` and evaluate SDFs/UVs in local space, so
CSS `transform` renders as a true rotated/skewed quad. `dom/transform.ts`
recovers the local size and translation from the computed matrix chain and
the measured AABB (an element's linear part is the ancestors' product; the
translation is solved from `getBoundingClientRect`; near-45° cases fall back
to `offsetWidth/Height`, glyphs to the font's content height). `matrix3d` is
flattened to 2D. Running CSS transitions/animations produce no mutation
records, so `DomSync` tracks them via transition/animation events and the
frame re-reads their parents' subtrees every frame while they run. Italic
runs whose face has no italic get a synthetic 14° shear via the same affine.

### The frame
`compositor.ts` owns the loop. Per frame: take dirty flags → if
LAYOUT/STYLE/CONTENT call `SceneReader.fullRead()`, if MUTATION call
`partialRead(scopes)` (the only places DOM layout is read) in `dom/tree.ts` →
re-anchor the canvas if the viewport left it (`place()`; reads
`scrollHeight`/`scrollWidth` only then or on LAYOUT) → run
`onGlyph`/`onFrame` hooks → `renderer.render()`. All DOM reads happen in one
batched phase before any GPU write. A partial read escalates to a full read when
the mutated element's border-box rect changed (siblings could move); inline and
`display:contents` elements are never boundaries. **Never call
`getBoundingClientRect` / `getClientRects` from a pass, a shader upload, or
anything downstream of the reader** — per-glyph rects are already a
forced-reflow hazard.

Backgrounds (gradients and images) are read in `dom/gradient.ts` and
`dom/backgrounds.ts`; they resolve colours and image URLs from the computed
style and paint as part of the box pass.

Dirty tracking is per layer (`scene.markDirty('text')` etc.); a pass's
`upload()` runs only when its layer is dirty. `onGlyph` dirties the text layer
every frame; dynamic images dirty the image layer every frame.

### RenderPass contract (`gpu/frame.ts`)
Every layer implements `upload(scene)` / `draw(encoder, first, count)` /
`destroy()`.
Conventions each pass must follow:

- **Bind group 0 is the shared `Frame` uniform**, set once by `Renderer`; the
  pass owns **bind group 1**. Any new pipeline layout is
  `[shared.frameLayout, ownLayout]`.
- Prepend `FRAME_WGSL` to the shader source so `doc_to_clip` and the `Frame`
  struct are in scope. `FRAME_BYTES` must stay in step with the struct.
- Instances live in a **storage buffer** indexed by `instance_index`, drawn as
  `encoder.draw(6, count, 0, first)` against a hardcoded 6-vertex quad — there
  are no vertex buffers anywhere. `draw(encoder, first, count)` is called once
  per cross-layer batch (`scene.batches`), so **instance index i must
  correspond to scene record i** of that layer (glyph i for text): never
  `continue` past a record in `upload()` — write a zero-size instance instead.
- Paint order is `record.z`, a unique integer assigned by
  `scene/stacking.ts` from a simplified CSS stacking-context tree; passes
  never sort or reorder.
- **Decorations and shadows are BoxRecords.** `dom/decorations.ts` turns
  `text-decoration` into one box per line fragment on `run.decorations`
  (flatten emits them just before the run); `readShadows` in `dom/styles.ts`
  turns `box-shadow` layers into boxes with `shadow` set — outer ones before
  the element's background box, inset ones after it. The box shader draws a
  `shadow` record as a blurred rounded rect (Wallace's analytic method) masked
  outside (outer) or inside (inset) the element's box. Underlines are split
  around descender ink (skip-ink). `text-shadow` lives in the text pass:
  shadow instances are appended after the glyph range in both text buffers
  (per run, per layer) and drawn before the glyphs of each batch.
- **Pseudo-elements** (`dom/pseudo.ts`): browsers expose pseudo STYLE but no
  geometry, so `::marker`/`::before`/`::after` are synthesised — Chrome does
  report px `width/height/left/top` for block and positioned pseudos, which
  are used when present; text is measured with Canvas 2D and anchored to the
  element's first/last glyph line. They become BoxRecords/GlyphRuns in
  `node.kids` (marker, ::before, kids, ::after) in the element's local frame.
- **Image atlas.** Static `<img>`/background sources ≤1024px are packed into
  one mipmapped `rgba8unorm` atlas (`images/imageAtlas.ts`, 4px gutters, UVs
  clamped by a half texel in the shader); canvas/video and larger images keep
  their own texture. `ImagePass.draw` collapses consecutive atlas-backed
  instances into one call. `draw()` returns the number of GPU draws issued
  (`stats().draws`). Mip generation lives in `gpu/mips.ts`.
- **Inline SVG and SVG images.** An inline `<svg>` root becomes one
  ImageRecord (`dom/svg.ts`: cloned, computed `color`/`fill`/`stroke` baked
  in, serialised to a `data:` URL, cached by FNV-1a hash of markup+size); its
  subtree is never walked. SVG sources are rasterised at DISPLAY size, never
  natural size (a 2560² gatsby sizer took seconds). Plain `<img>` sources go
  through `createImageBitmap` because `naturalWidth` is density-corrected for
  `srcset` images while the decoded bitmap is not. Borders are per side
  (`border.widths`/`colors`, mitred in the shader).
- **Opacity groups.** A context with `opacity < 1` is an `OpacityGroup`
  (paint-order range + alpha + doc-space bounds, `scene.groups`). The batch
  list carries `push`/`pop` markers at its cuts; `Renderer` renders the range
  into a pooled offscreen texture (own Frame uniform: viewport = texture size,
  scroll = group origin) and `gpu/composite.ts` draws it back once with the
  group alpha. Records therefore carry `opacity = 1`; passes stay unaware.
- **Cutouts** (`boxes/cutoutPass.ts`). A `data-gpu-ignore` element
  (`IGNORE_ATTR`) is not mirrored: the reader gives it an `ElNode` with one
  own `CutoutRecord` (border box, radii, local/xform, space, ancestor clip)
  and no kids, and it keeps its stacking context, so the hole gets the z the
  element would paint at (never an opacity group). The `cutouts` layer
  draws it destination-out (`zero` / `one-minus-src-alpha`, fragment
  `vec4f(0, 0, 0, coverage)`): records painted before it are erased inside
  the rounded rect, records after it paint over the hole, and the page's
  own paint of the element shows through the canvas. The layer is added
  whenever any other layer is; `stats().cutouts` counts the records. Inside
  an opacity group a cutout clears only the group's target (the parent
  target's content stays under the hole). Mutations inside an ignored
  subtree are not observed; attribute changes on the ignored element
  itself re-read its parent, so class/style toggles move the hole. Not
  covered: its CSS transitions/animations and size changes driven by its
  own content (a fixed element doesn't resize the root), until the next
  read of its parent. Replace mode leaves ignored elements painting.
- Grow buffers by doubling in an `ensureCapacity`-style method and rebuild the
  bind group; `writeBuffer` only the used prefix.
- Call `reportShaderErrors(module, label)` after `createShaderModule` — it is
  the only way WGSL compile errors become visible.

Colours are **sRGB-encoded** (via a 1×1 canvas probe in `util/color.ts`, no
linearisation) and blending is **premultiplied in sRGB space** (`one` /
`one-minus-src-alpha`), deliberately, to match browser compositing —
fragment shaders still return `vec4f(rgb * a, a)`.

### Text (`src/text/slug/`)
The marquee feature; read `src/text/slug/README.md` for data layout and
provenance. Pipeline:

1. `dom/textRuns.ts` ranges over each **grapheme** (`Intl.Segmenter`) in a text
   node and takes its client rect — this is how the browser's shaping, kerning,
   bidi and line breaking are inherited for free. With `FAST_TEXT_READ`
   (on; off under a transform) it takes far fewer rects: one
   `getClientRects()` per text node (a rect per line fragment), with lines
   and graphemes placed from Canvas 2D `measureText` suffix widths
   (`readLines`), else one Range per whitespace-free chunk (`readChunk`),
   else per grapheme. A split is used only when the canvas widths match the
   browser's rects within 0.05px; ligature candidates (`f[fijlt]`), non-Latin
   scripts, emoji, bidi, justify and styles the canvas `font` can't carry
   (feature/variation settings, `font-optical-sizing: none` on an opsz
   axis) take the per-grapheme path. `stats().textRead` counts graphemes,
   per-grapheme reads and Range queries. `glyphId` is the
   grapheme's **first code point**; `SlugText` remaps it through the font cmap.
   Ligatures: `font.ts` builds a `liga`/`clig` lookup from GSUB and the
   rasterizer draws the ligature glyph over adjacent, abutting, same-line
   component graphemes (Chrome splits a ligature's advance across them), so
   fi/fl/ffi match the browser; `calt` contextual alternates are not applied.
2. `font.ts` (opentype.js) flattens each outline to quadratics normalised into
   the glyph's own tight bbox `[0,1]²`, **y-up**, and buckets them into 16
   horizontal bands. It reads `glyph.path` (font units, y-up) — *not*
   `getPath()`, which is y-down and baseline-relative and silently produces
   nothing. This trap has already been hit once (commit 602d3e3).
3. `rasterizer.ts` (`SlugText`) packs bands + curves into storage buffers once
   per font and one 16-float instance per on-screen glyph. The instance quad is
   the glyph's **ink box**, derived from ascender/descender metrics and the
   grapheme's line box — not the line box itself — so outlines aren't stretched.
4. `shaders.ts` computes signed sub-pixel coverage from the band's curve
   crossings with a 3-tap vertical supersample. No atlas, no resolution ceiling.
5. **Fallback atlas** (`text/glyphAtlas.ts` + `text/atlasShader.ts`): any
   grapheme Slug can't draw — emoji/colour glyphs, code points the face lacks
   (`.notdef`), multi-code-point clusters, or a run whose family has no
   registered face — is rasterised by Canvas 2D with the element's font stack
   into a shared `rgba8unorm` atlas and drawn as a textured quad by a second
   pipeline inside the same pass. Mono glyphs are rasterised white and tinted;
   emoji keep their colours. Both pipelines share ONE instance index space:
   every glyph writes a real instance to one buffer and a zero instance to the
   other, so `draw(first, count)` stays aligned with scene glyph order. The
   atlas is cleared on `document.fonts` `loadingdone` (the observer also forces
   a full re-read then). `stats().fallback` counts atlas glyphs per frame.

`textRasterizer.ts` is the seam: any backend (e.g. MSDF) can implement
`TextBackend`. Fonts are supplied as bytes via `compositor.text.loadFontBuffer()`
— `prepare(FontFace[])` is still a stub, because `FontFace` doesn't expose its
parsed bytes.

## Constraints that shape the code

- **No layout ownership.** If a change would require computing CSS layout,
  line-breaking or shaping, it is out of scope. We read the browser's geometry.
- **Graceful bail.** `initGpu` returns `null` rather than throwing; with the
  default `fallback: 'passthrough'` the compositor is inert and the page is
  untouched. Keep that path intact.
- **SSR-safe.** Importing the package on the server must be inert — all DOM and
  GPU work stays lazy and client-only (it's consumed by a Gatsby site; see
  `docs/INTEGRATION.md`).
- **Dependency-light.** TypeGPU + opentype.js only. No framework, no three.js.
- TypeScript is strict with `noUncheckedIndexedAccess` and
  `verbatimModuleSyntax` (use `import type`). Biome: single quotes, no
  semicolons, 2-space indent, 80 columns.

## Delegating to sub-agents

Model tiers for ANY delegated work - Agent-tool and Workflow-script `agent()` calls alike. Set the `model` parameter explicitly on every call; never omit it(omission silently inherits the session model)
- `haiku` - mechanical bulk work: renames, boilerplate, format conversion, log triage
- `sonnet` - default for well-specified impolementation with clear acceptance criteria
- `opus` - genuinely tricky work: concurrency, subtle algorithms, adversarial verify/judge panels, gnarly debugging
- `fable` - rare; only when independence from your own context is the point (eg: adversarial review of your own plan or a large diff). If you want to call a Fable sub-agent because the complexity of the task warrants it, ALWAYS check with me first - never spawn one unprompted

When unsure between tiers, pick the cheaper and escalate on failure

## Additional Guidelines

The number of tokens used to edit files is best minimized, all else being equal. Therefore, when it will not affect the end result, try to surgically edit a file rather than rewrite the entire thing.

Please remove all mannered prose.
## Git workflow

Never commit on your own. Make changes and leave them uncommitted so I can
review the diff; I decide when to commit.
