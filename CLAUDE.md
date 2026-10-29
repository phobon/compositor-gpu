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

`npm run test:round -- <evidence-dir> [ab-flag]` (`test/round.sh`) runs
the visual, fx, edit, fill (down and up) and profile harnesses in
sequence on a machine with a GPU, saving each step's output and a
summary (`<date>-m1pro-round.txt`) into the folder; `PROFILE`, `SKIP`
and `LABEL` adjust it. The cloud workspace has two cores and no GPU
(SwiftShader: ~10 min per stall check, ~20 per visual run), so full
checks and all timings run on the M1 Pro through it; the workspace only
typechecks and lints. The visual and fx harnesses run headless, which
falls back to SwiftShader on the Mac too (regression against goldens
made the same way); the edit, fill and profile steps run headed. Under
SwiftShader, Slug text drawn on the page differs from the same text in an
isolated group (layer transform, region, distance field) by up to ~35
levels at some absolute positions; on the GPU they match
(`npx tsx test/diag/group_text.ts [--swiftshader]`), so don't chase such a
diff without a headed check.

Baked fonts (M5f): `npm run bake [-- config]` (tools/bake.ts) writes
`.cgf` files and a manifest that `createCompositor({ assets })` reads;
`npm run bake:playground` bakes `playground/compositor-gpu.bake.json` into
`playground/gpu/` (gitignored) for `?baked` pages.

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
over five reads), and to ~7.8k with the split under transforms; what
remains is 16px titles (opsz mismatch, see Text) and computed-style
reads. Timings swing ±30% run to run in the sandbox (more when other
jobs share the machine), so compare A/B in the same session. That page draws in ~114 calls: the batch builder indexes
members in a 128px grid and tests text runs per glyph (a run's union rect
spans whole paragraphs and blocked every merge), and shadow records use a
1.5σ `batchRect` footprint. On the main target each batch draws only
the instance runs whose records reach the canvas region grown by half a
canvas (`gpu/cull.ts`: a `Culler` owning the bounds, the idle-built index
and three cached queries, `canvas` / `rows` / `strip`, each cached per
batch list until the canvas leaves that
region; each instance's bounds are computed once per batch list into
typed arrays, walked on the first queries and indexed by y in idle time
250 ms later, so a scroll's recompute visits only nearby instances; a
page that re-sorts every frame never builds the index; `stats().cullMs`
and the profile's `cull` row, under `encode`, time a recompute; gaps under 64 instances are drawn through; batches with a
non-builtin material are drawn whole, their vertex hooks may move
geometry): perf.html submits ~11k instances in 33 draws instead of ~76k
in 123. `cullDraws: false` turns it off; `test:perf` and `test:profile`
take `--nocull` for A/B, and `stats().instances` counts what was
submitted. Group targets are not culled.
`readMs` / `uploadMs` / `encodeMs` are in `stats()`. Don't call `window.scrollX`
in the reader — the read pass (`dom/read_pass.ts`, `ReadPass`, one per
full or partial read) snapshots it, with the selection and the per-pass
caches and text-read counts; rects are converted through a view for the
space they measure into (`pass.at(space).docRect(r)`), passed down as an
argument (`readTextNode(at, …)`, `selectionBoxes(at, …)`).

**Frame profiler**: `compositor.profile` (`src/profile/`). While a
recording runs (`start()` / `mark()` / `stop()`), the flight recorder is
on (`flight()`, `save()`) or the HUD is shown (`hud()`), each frame
records its CPU time split into read, hooks,
upload, encode and other, the read kind (`none` / `partial` / `full` /
`escalated`) with its cause (`SceneReader.lastRead`, the dirty flags),
and GPU pass timings when the device has `timestamp-query`
(`gpu/timer.ts`; labels `main`, `group`, `region`, `layer`, `post`,
`fx:<pass>`; passes overlap on Chrome/Metal, so a label's summed time
overstates its cost; the report's `alone` row under each label is the
time its passes ran with no other pass running, which is not a cost on
Metal either: a later pass's begin timestamp lands while an earlier one
still runs, so `main` alone reads ~1.3 ms of a ~7 ms main pass and 0
under load. `gpu total` (first begin to last end) is the occupancy that
predicts dropped frames (`docs/rd/experiments/2026-10-16-gpu-headroom.md`:
frames drop at 120 Hz with ~1.7 ms added to a 7 ms dpr 2 scroll frame);
an A/B without the feature gives a feature's cost). New render passes spread `timed(shared.timer, label)` into
their descriptor; never `timestampWrites: undefined`, which stalls
SwiftShader. `canvasFill: 'band'` (the default; page-pinned canvas only,
`canvasPin: 'viewport'` uses 'full') scissors the main pass to the viewport plus a band sized to the scroll
steps of the last 200 ms (at least 128 CSS px) and skips groups outside
it; everything a pass draws on the main target resets to that scissor
(`Target.scissor`, `restoreScissor`); draws are culled to the band
(`cullDraws: 'canvas'` culls to the canvas instead, for A/B). 'band'
draws into a texture kept between frames (the canvas texture isn't),
cleared and redrawn only in the band (`ClearRect`), its pixels shifted
by a texture copy when the canvas re-anchors, and copied to the canvas
in a `copy` pass, or into the post chain's scene texture when a chain
runs. The rows a re-anchor newly covers are cleared and drawn a strip
per frame (`reanchorStrips`, `?nostrips` / `--nostrips`): at least 96
CSS px or twice the recent scroll step, from the pending interval
nearest the band, as a second draw culled to that interval (or merged
into the band when it touches it); pending rows keep the loop running
and turn scene reuse off, and with a backdrop in the scene they are
drawn at once (`stats().pendingRows`). Which rows each frame draws, and
which stay valid, is decided by `gpu/fill_planner.ts` (`FillPlanner`:
pure, no GPU objects; `plan()` returns skip or a draw plan and updates
its rows in the same call, `reuse()` on scene-reuse frames); the
renderer carries the plan out (shift copy, scissors, draws) and owns the
textures. `npm run test:unit` (`node:test` under tsx, no browser) replays
traces recorded from the renderer before the planner
(`test/unit/traces/`) and checks it frame for frame. With
`skipUnchanged` (default; `?noskip` / `--noskip`) the planner keeps the device rows of the kept
texture drawn since the content last changed (`valid`, shifted on
re-anchors): band rows in it aren't redrawn, and a frame with nothing
to draw returns before `getCurrentTexture` (the canvas keeps what it
last presented; `stats().skippedFrames`, the profile's `skipped`).
The content key (`gpu/effect_snapshot.ts`, `snapshotEffects`: one view
of the effect registries per frame, built before the uploads) is
conservative: dirty layers, a new scene version, batch list or settled
material pipeline, and anything drawn differently every frame (active
extra layers, a material reporting `changed()` or a change in the
active set, backdrops) empty `valid`. The snapshot's `effectOf(group)`
is the one place an active region pass takes precedence over a layer
transform. Layer transforms and active region passes are damage
(`layers`:
their groups' rows at this frame's and the last drawn frame's affine,
padded by the region's `pad()`; nested or viewport-space ones fall
back to the full redraw;
`docs/rd/experiments/2026-10-17-layer-damage.md`). Fixed
(viewport-space) content is damage instead: when the scroll differs
from the one it was last drawn at (`fixedScrollY`), its rows at both
scrolls (`fixedRows`: record rects, glyphs with text-shadow extent,
groups' `vbounds`) are drawn as extra scissored draws with the band's
remaining rows (`docs/rd/experiments/2026-10-17-fixed-damage.md`), each
of those draws culled to its own rows (`Culler.rows`: 128 CSS px tiles,
cached per batch list); a
frame after a post-chain frame is never skipped
(`docs/rd/experiments/2026-10-16-skip-unchanged.md`); `'band-clear'` clears
outside the band instead, `'full'` redraws everything. perf.html stays
on 'full' unless `?band` / `?bandclear` (the profile baselines). `npx
tsx test/fill/run.ts [--headed] [--fixed] [--blur] [--up]` shows what a
stalled main thread then reveals, against 'full'. A frame is paced when the previous one asked for it or it
was requested within a refresh interval of it; lateness is its interval
then, else its wait since the request. `stop()` reports percentiles,
late/dropped frames, read causes and the worst hitches with a cause
(compositor CPU, GPU, script from long animation frames, or outside).
Off, it costs a few `performance.now()` calls a frame. The HUD's text
lines show CPU/GPU p50/p95, GPU ms per pass label, the share of frames
that reused the scene, draws and read kinds; B freezes them as a
baseline and shows each number's change against it, R switches
`compositor.sceneReuse` and restarts the counted window.
`npm run test:profile` records scenarios on `perf.html` (`--only`,
`--n`, `--frames`, `--viewport`, `--headed`, `--save`, `--baseline`) or
scrolls any page exposing `window.__gpu` (`--url`). SwiftShader numbers
are only meaningful for CPU.
While recording or flying, each sample also has `why` (profile/trace.ts:
DomSync's `trace` sink gets each invalidation; the compositor passes the
re-read scopes and what kept the loop alive, effects naming theirs via
`FrameHook.alive`), and each hitch `factors` (profile/explain.ts, pure;
unit-tested in test/unit/profile_explain.test.ts); a new invalidation
source in DomSync should call `this.trace?.(kind, node, detail)`.
`npm run test:profile -- --explain` janks layout.html on purpose and
checks save() explains it. Recordings: profile/recording.ts (format v1;
bump RECORDING_VERSION on a breaking change to ProfileReport).
The panel is `src/devtools/` (`compositor-gpu/devtools`, plain DOM and
canvas in a shadow root, no framework): model.ts (a report as the views
need it; pure apart from `h()`), timeline.ts, frame_view.ts,
elements_view.ts, live_view.ts, index.ts (shell, settings, recordings,
keys). `compositor-gpu/debug` is an alias for it.
`profile.tracks(true)` writes Chrome DevTools custom tracks
(profile/tracks.ts); `npm run test:profile -- --tracks` checks a Chrome
trace for them.
The CLI is tools/profile.ts (`npm run profile`), with tools/profile/
(scenario, budget, compare: pure and unit-tested in
test/unit/profile_cli.test.ts; html: the report, building
src/devtools/viewer_entry.ts as an IIFE cached in the OS temp dir) and
tools/inject.ts (the inject bundle, shared with test:site).
`profile.filmstrip()` (profile/filmstrip.ts) copies the canvas in the
frame's own task, from Profiler.push via `ProfileHost.view()`: a WebGPU
canvas is only readable before it presents. Comparisons are
src/profile/compare.ts, shown by devtools/compare_view.ts.

**Debug panel**: `mountDebugPanel(compositor)` (`compositor-gpu/debug`,
`src/debug/index.ts`) puts a GPU button in a corner (bottom-right by
default) whose panel toggles `stats` (`profile.hud`), `dials`
(`setDialsShown`: dials entries always register, panels are built only
while shown; `?dials=1` is the initial state) and `skeleton`
(`compositor.skeleton` → `Shared.skeleton`, `gpu/skeleton.ts`: the box,
image, Slug, atlas, cutout and `/fx` Layer pipelines each have a
`SkeletonTwin` over the same module, `line-list` with the `SKELETON`
override on and fragment `skeleton_fs`; `skeleton_vi` in the vertex
shader (inside `mat_corner` for record passes) walks each triangle's
edges, 12 vertices per grid cell (`quadVerts`), material variants too
(`PassPipelines`' `wires` set); vertex hooks, groups, layer transforms
and post passes apply as usual, clips don't; toggling empties the fill
planner's `valid` rows and the scene-reuse key). Flags persist in
localStorage and are overridden by `?stats=` / `?dials=` / `?skeleton=`.
The playground pages mount it unless `?vr` or `navigator.webdriver`.

**Effects harness**: `npm run test:fx` (`test/fx/run.ts`, `-- --update`
to rewrite goldens, `-- --only <shot>`) loads `playground/fx.html?vr`,
pins time/elapsed/pointer through `fx.__override`, and captures each
section GPU-only against local goldens (`test/fx/golden/`, gate 0.5%, no
parity column): `fx-off`, `fx-tgpu` (a `tgpu.fn` fragment), `fx-blur`,
`fx-blur-scissor` (loop stopped, scrolled half a viewport: the canvas that
was off-viewport must be unblurred), `fx-displace`, `fx-blur-then-off`
(off → on → off; the last must equal the first exactly), `fx-displace-push`,
and on the geometry section `fx-geometry`, `fx-glow`, `fx-ripple`, `fx-after`,
`fx-region`, `fx-region-then-off` (must equal `fx-geometry` exactly),
and on the materials section `fx-materials`, `fx-mat-ripple`,
`fx-mat-wave`, `fx-mat-bend` (plus a check that the `<img>`'s DOM paint is
hidden while on), `fx-mat-stripes`, `fx-mat-all`, `fx-mat-then-off` (must
equal `fx-materials` exactly), and on the M3b section `fx-m3b`,
`fx-layer-glyphs`, `fx-layer-image`, `fx-sim` (fixed `dt` override, run
until `layer.steps` ≥ 90), `fx-mat-raw`, `fx-mat-tgpu`, `fx-tgpu-js`
(on the fx-off section), `fx-m3b-all`, `fx-m3b-then-off` (must equal
`fx-m3b` exactly), and `fx-follow`, `fx-mat-stagger` (a `mat_index`
stagger), `fx-follow-then-off` (must equal `fx-follow` exactly),
`fx-pass-image` (a pass with `image`, on the fx-off section),
`fx-rgbsplit`, `fx-rgbsplit-pointer`, `fx-glitch`, `fx-vignette`,
`fx-lens` and `fx-p1-then-off` (all five on, then off: must equal the displace
section with nothing enabled exactly), `fx-shockwave` (a ring 250 px
out at the pinned elapsed) and `fx-shockwave-then-off` (must equal the
section exactly), on `playground/morph.html` `fx-morph-a` (the first
string), `fx-morph-0` (captured, changed, held at progress 0: must equal
`fx-morph-a`), `fx-morph-half`, `fx-morph-1` (must equal `fx-morph-b`)
and `fx-morph-b` (ended, the live text), `fx-morph-assemble-half`,
`fx-morph-assemble-1` (must equal `fx-morph-b`), `fx-morph-scatter-0`
(must equal `fx-morph-b`), `fx-morph-scatter-half`, `fx-morph-baked` /
`fx-morph-baked-half` (morph.html?baked from baked fonts, baked first:
equal to `fx-morph-a` / `fx-morph-half`, opentype.js never loaded), on `playground/sdf.html` `fx-sdf` (glows from distance fields) and
`fx-sdf-off` (all destroyed: must equal the page loaded with none), on
`playground/vectors.html` `fx-vectors` (baked svg files drawn from imgs;
`-twins`: each equal to its inline svg, `-morph-half`, `-morph-0` equal
to the old icon at rest, `-unbaked`: images without the manifest), on
`playground/textures.html` `fx-textures` / `-off` (baked textures in a
pass, layer and material; `-ramp`: the layer's 1:1 ramp equal to
ramp.png over the page), on `playground/masks.html` `fx-masks` (glows from
baked distance masks; `-vs-live`: the baked star's field against a live
field of the same star, mean under 0.5 CSS px), on `playground/layout.html`
`fx-layout-a` (the grid), `fx-layout-0` (keyed layout morph to the
detail view held at progress 0: must equal `fx-layout-a`),
`fx-layout-half`, `fx-layout-1` (must equal `fx-layout-b`) and
`fx-layout-b` (ended, the detail view), `fx-layout-scroll-a` / `-0` /
`-half` / `-1` / `-b` (the same on `layout.html?scroll`, from 380 px down
back to the top; -0 equal to -a, -1 to -b), `fx-reveal` / `fx-reveal-0`
(reveal on the section's h2 and develop on its img at progress 0.4 / 0)
and `fx-reveal-then-off` (must equal the section exactly), on the
displace section,
and on `playground/transition.html` `fx-transition-a` / `-b` (each
state), `fx-transition-0` (captured a, swapped to b, settled, progress
0: must equal `-a` exactly), `fx-transition-half`, `fx-transition-1`
(must equal `-b` exactly), on `playground/gallery.html?vr`
`fx-gallery-pre`, `fx-gallery` (the ring held still) and
`fx-gallery-off` (must equal `-pre` exactly),
`fx-progressive` (progressiveBlur toward the bottom corners, as a region
pass on an arc of images), and on the transform section
`fx-transform-off`, `fx-transform` (three cards under pinned layer
transforms, one past the row's clip), `fx-transform-identity` and
`fx-transform-then-off` (both must equal `fx-transform-off` exactly),
`fx-dissolve` (the row half dissolved) and `fx-dissolve-full` (progress
1: must equal `fx-transform-off` exactly), and on `playground/trail.html`
(replace mode, a scripted stroke held at decay 1) `fx-trail-off`,
`fx-trail`, `fx-trail-pixel`, `fx-trail-clear` (must equal
`fx-trail-off` exactly) and `fx-trail-reuse` (the page pass alone over a
still page: frames must reuse the scene, and equal `sceneReuse: false`
exactly); `fx-waapi` (a box faded by `element.animate()`, equal exactly
to the same opacity set as a style), `fx-mat-shared` (two materials
with the same hooks compile one pipeline), `fx-svg-transition` (an
inline svg icon in a badge under a running scale transition stays in
the scene every frame: no re-rasterising on sub-pixel size drift) and
`fx-reduced` (displace on
the real clock under reduced motion: two captures 400 ms apart equal
exactly; `motion.play()` lands at once). Material pipelines compile asynchronously:
the harness waits for `fx.__pending()` to reach 0. Console errors
from the library fail it. `npm run test:visual -- --with-fx` loads the
main playground with `/fx` installed and no pass enabled; it must match
the plain goldens at 0.00. The perf harness also reports `steady encode
(blur)` and `animated transforms` (up to 30 cards in view animated through
CSS transforms vs `fx.transform`: frame interval and compositor CPU per
frame; SwiftShader frame intervals are meaningless with offscreen groups). Never run two harnesses at once (they time each other out), and
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
bundles five ES entries, `src/index.ts` → `dist/compositor-gpu.js`,
`src/fx/index.ts` → `dist/fx.js` (`compositor-gpu/fx`), `src/react/index.ts`
→ `dist/react.js` (`compositor-gpu/react`: provider and hooks),
`src/dials/index.ts` → `dist/dials.js` (`compositor-gpu/dials`: DialKit
panels from effect schemas) and `src/debug/index.ts` → `dist/debug.js`
(`compositor-gpu/debug`: the debug panel), with `typegpu`, `opentype.js`, `react` and
`dialkit` external (the last two optional peers). `src/react` is the only
code that imports React (biome's React rules apply there only); it loads
the core and `/fx` by dynamic import, so SSR stays inert. The core entry
itself is small: `createCompositor` (`src/create.ts`) returns the inert
compositor when `navigator.gpu` is missing and otherwise loads
`compositor.ts` by `import()`, a separate chunk and the only one that
imports typegpu; opentype.js is a further `import()` (`loadParser` in
`text/slug/font.ts`). Keep value imports of the renderer out of
`src/index.ts` (`SlugText` is exported as a type). Site-specific
choreography (reveals, scrubs, transitions) stays in the sites: GSAP on
bonobolabs.com, Motion on phobon.io. `@/*` aliases `src/*` in both
tsconfig and vite.

## Status

`docs/HANDOFF.md` is the session handoff for the bonobolabs.com `/duo`
integration: checkouts, uncommitted state, how to run the site and the
readout, and the first move on each open problem. Read it before touching
the site side.

`docs/adr/` records architecture decisions not to revisit without
new reasons (read before proposing a refactor). `ROADMAP.md` is the live checklist, `docs/ARCHITECTURE.md` is the mirror's
spec and `docs/EFFECTS.md` the effects layer's (`compositor-gpu/fx`) — the
spec describes the target, not all of which is built. Currently real: the box
pass (a complete DOM→GPU vertical slice) and the Slug text pass (font pipeline +
WGSL, rendering but still being tuned). `ImagePass` renders `<img>`, `<canvas>`,
`<video>` and `background-image url()` with mipmaps and rounded clipping;
gradients live in the box pass. Read `ROADMAP.md` before assuming a feature is missing by accident.

**Effects layer** (`src/fx/`, `compositor-gpu/fx`): spec in
`docs/EFFECTS.md` (with Deviations sections for what M1, M2 and M3
changed), author contract in `src/fx/README.md`. M1, M2 and M3 are built:
`createEffects(compositor)`, Params, the pointer, fullscreen and region
`fx.pass`, `fx.target` (incl. `image`), `fx.layer` (with a `simulate`
compute hook dispatched from its `frame()` in its own submit, `image`
and `glyphs` bindings resolved at draw time via `graph.imageOf` /
`graph.glyphTable`), `fx.material` (with `raw` programs, `rawProgram` in
`gpu/material.ts`), the TypeGPU externals `gpu`/`MatIn`/`Quad`
(`src/fx/gpu.ts`; tgpu.fn hooks resolved together with `names:
'random'`), presets `blur`/`progressiveBlur`/`displace`/`cursorGlow`/
`clickRipple`/`ripple`/`dissolve`/`rgbSplit`/`glitchSlices`/
`vignette`/`lens`/`reveal`/`develop`/`gallery` (a Layer over the
`images` binding, `fx/imageArray.ts`)/`radialReveal` (a transition); `fx.transition` (`fx/transition.ts`: a fullscreen pass with
a held viewport snapshot, `prev(uv)` in group 3, shown alone until
`settled()` finds `graph.mirrorComplete()` on two frames; `npx tsx
test/transition/run.ts` times swaps on `playground/transition.html`). M4 (authoring, `docs/EFFECTS.md`
"Authoring"): `fx.motion` (from/to channels by `progress`, a basic
`play()`), transforms and motions on one element combined into its
single layer transform (`fx/compose.ts`), `schema` on every params
object, `createEffects` memoised per compositor and counted
(`release()`), no DOM fallback (inert without WebGPU); timing comes
from GSAP/Motion (recipes in `src/fx/README.md`). Reduced motion
(`fx/reduced_motion.ts`, `fx.reducedMotion` / `setReducedMotion`): the
effects clock (`fx/clock.ts`, `EffectsClock`: `time`, `held`, `elapsed`,
the test overrides) holds still, held-clock `continuous` passes/materials
stop keeping the loop alive, and `motion.play()` jumps; shot
`fx-reduced`. Passes, layers, materials and trails share
`fx/lifecycle.ts` (`Lifecycle`: `enabled` / `continuous` with their wake
rules, the effect's clock start, destroy; `keepAlive` over all of them;
each kind adds its side effects through `toggled` / `busy`); transforms
and motions run on the composer. The playground's dev server runs `unplugin-typegpu` (dev
dependency) for the `'use gpu'` hooks in `fx.html`. Materials: the box, image
and Slug shaders are templates around `mat_vertex`/`mat_fragment`
(`gpu/material.ts`; default variant = identity hooks, pixel-identical),
records are tagged with a material id by `Scene.assign` before each batch
build and batches never mix materials; material pipelines compile async
and fall back to the default pipeline until ready or on error (a
`hold` material's records aren't drawn until ready instead). Layers draw at `extra` entries of `scene.batches` (anchors
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
`pass.at('doc').docRect`). `doc_to_clip()` in `gpu/frame.ts` maps that to clip space in the
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

`canvasPin: 'viewport'` swaps this for a `position: fixed`, viewport-sized
canvas whose anchor is the scroll position every frame (`place()`), for
pages with effects fixed to the viewport (a viewport-space post pass
would otherwise ride a frame with the page during fast scrolls); the
whole page then trails the scroll by up to a frame instead.

The one exception is `position: fixed` on the viewport: the reader walks
that subtree through the pass's viewport view (`pass.at('viewport')`: no
scroll offset) and tags its records `space: 'viewport'`; every vertex shader
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
frame re-reads their parents' subtrees every frame while they run. Script
animations (`element.animate()`, `Animation.play()`, which Motion uses
for opacity/transform) fire no events: the first DomSync to start wraps
those two entry points (`hookScriptAnimations`), and each reports its
target until its `finished` settles. A paused one scrubbed through
`currentTime` is not seen. Italic
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
`display:contents` elements are never boundaries. A partial read that
leaves each re-read subtree's records the same in number, kind, order,
space, clip (no exact shape), per-run glyph and shadow counts, with no
stacking context or region in it, is patched in place instead of
rebuilt. `dom/scene_sync.ts` owns both (`rebuild(scene, tree)`,
`patch(scene, swaps, { contexts })`) and `walkRecords`, the one place a
subtree's record order is defined (`flatten` and the patch's record
pairing both use it); `npm run test:unit` checks a patched scene equals
one rebuilt from the edited tree. A patch goes through `Scene.replace`
(new records take the old ones' z and index; `version` bumps), re-tags
materials once, and rebuilds batches (`Scene.rebatch({ retag: false })`)
only if materials changed; records that moved inside an opacity
group fall back to the rebuild. Moved records go through `Scene.refit`
(`refitBatches`, `refitBatches: false` / `?norefit` to compare): the
list is kept when no moved record's new footprint overlaps a member of
another batch drawn on the wrong side of it (members kept from the
build in `BatchState`, each with its paint index and the refit that
added it; whitespace glyphs have no footprint), and the culler writes
the moved instances' bounds in place (`updateBounds`, `Scene.moved`). The text pass then re-packs only
the replaced runs (`patchRuns`), falling back to a full pack on a slot
eviction, atlas reset or newly live pipeline. With `patchOpacity` (default
on) a re-read subtree may also hold stacking contexts if both reads have
the same ones (z, own count, group-ness; no filter, blend group,
isolation or region): records are replaced in place and each group takes
its context's new alpha (`OpacityGroup.key` is the context's ElNode). An
element read below opacity 1 stays a group at alpha 1 (`holdGroup`)
until 1 s after the latest such read of any element, so a fade never
changes the structure; `expiredHolds` re-reads the held elements once
when the holds end. `patchEdits: false`
(`perf.html?nopatch`, `test:profile --nopatch`) always rebuilds;
`stats().patchedReads` counts patches; `npm run test:edit` checks a
patched canvas against a rebuilt one. **Never call
`getBoundingClientRect` / `getClientRects` from a pass, a shader upload, or
anything downstream of the reader** — per-glyph rects are already a
forced-reflow hazard.

**Scene reuse:** while the post chain runs, `Renderer.render` skips
uploads, groups and the main pass when nothing feeding the scene texture
changed (the snapshot's `reuseKey()`: canvas geometry, scroll, dpr, the
values of layer transforms on groups in the scene, the active materials
and that each reports `changed() === false`, the material-pipeline
settle counter; no active extra layer or region pass in the scene; the same
batch list; no dirty layer) and runs the chain on last frame's texture
(`renderPostOnly`, `stats().sceneReused`). `/fx` materials report
`changed()` from their params, time use, trail and pointer reads.
`sceneReuse: false` turns it off.

**Replace-mode handoff:** `start()` doesn't hide the source. The canvas
renders at opacity 0 (drawn over the page it doubled the text) until the
mirror is complete (fonts resolved, no `<img>` in the viewport still
loading, `ImagePass.pending` 0, no material pipeline compiling) or
`handoffTimeout` (1500 ms) passes; then `frame()` shows the canvas and
hides the source right after `render()`, so both land in one paint,
applies the hides materials asked for meanwhile (`graph.hideSource` waits
for the handoff), discards its own mutation records
(`DomSync.discardPending`) and resolves `compositor.ready`. A
`setSourceHidden()` call meanwhile cancels the automatic hide and shows
the canvas.

Backgrounds (gradients and images) are read in `dom/gradient.ts` and
`dom/backgrounds.ts`; they resolve colours and image URLs from the computed
style and paint as part of the box pass. Every `background-image` layer
paints (`backgroundLayerRecords`): the bottom layer's gradient rides in
the element's own box record over the colour; the layers above are their
own records, bottom to top (gradients as border-less boxes that keep the
border widths, url() layers as ImageRecords with `bgSize` for explicit
`background-size` lengths), and the border moves to a record on top when
one of them reaches the border area. Gradient kind in the box shader is
1 linear, 2 radial, 3 conic, + 8 when repeating; a gradient layer sized,
positioned or with an origin other than the padding box carries
`gradient.tile` (padding-box relative, packed in the box's `gt`), and
`gradient.repeat` wraps per axis (`sh0.w`: 1 x, 2 y). Radii are per axis (`readCornerRadii`):
records carry `radius` (horizontal) and `radiusY` only when elliptical;
the box, image and cutout shaders use `sd_box` (`gpu/sdf.ts`), which is
`sd_round_box` exactly when circular. Shadows are elliptical too
(`shadow_x`/`shadow_cov`; inset shadows' inner vertical radii ride in
`gt`), and reduce to the circular expressions when `radiusY` equals
`radius`. **Clip shapes:** a clip rect (`Rect`) can carry `shape`
(`ClipShape`: record space → the clipping element's padding-box frame,
size, inner radii), set by the reader (`clipShapeFor`) when a clipping
ancestor is rounded or rotated, and inherited inside it (the innermost
such ancestor wins; outer ones clip by their AABB). `Scene.clipIndex`
numbers them per build (index 0 = none); the renderer uploads
`scene.clipShapes` to a fixed table (`MAX_CLIP_SHAPES`) bound at group
0 binding 1, and every pass writes the index into a spare instance
lane and multiplies its output by `frame_clip_cov(docp, index)`
(`FRAME_WGSL`, anti-aliased from `frame.dpr`, no derivatives); the
group composite does the same for layer transforms. The selection highlight (`dom/selection.ts`) is read
with the text: boxes at the front of `run.decorations`, re-read on
`selectionchange` for the text parents the old and new selections touch
(`selectedParents`; a full read past 256).

Dirty tracking is per layer (`scene.markDirty('text')` etc.); a pass's
`upload()` runs only when its layer is dirty. `onGlyph` dirties the text layer
every frame; dynamic images dirty the image layer every frame.

### RenderPass contract (`gpu/frame.ts`)
Every layer implements `upload(scene)` / `draw(encoder, first, count,
material?)` / `destroy()`; the record passes (box, image, Slug) also take
a `MaterialBinding` and draw that batch with its pipeline variant (bind
group 2, `6·n²` vertices for `subdivisions` n; see `gpu/material.ts`).
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
  around descender ink (skip-ink). Line positions, thickness and styles
  follow Blink (`TextDecorationOffset`, `DecorationLinePainter`): double is
  a second box; dashed, dotted and wavy boxes carry `line` and the box
  shader draws the pattern (`line_cov`, grad kind -1/-2/-3). `text-shadow` lives in the text pass:
  shadow instances are appended after the glyph range in both text buffers
  (per run, per layer) and drawn before the glyphs of each batch.
- **Pseudo-elements** (`dom/pseudo.ts`): browsers expose pseudo STYLE but no
  geometry, so `::marker`/`::before`/`::after` are synthesised — Chrome does
  report px `width/height/left/top` for block and positioned pseudos, which
  are used when present; text is measured with Canvas 2D and anchored to the
  element's first/last glyph line. They become BoxRecords/GlyphRuns in
  `node.kids` (marker, ::before, kids, ::after) in the element's local frame.
  A pseudo's own `transform`/`translate`/`rotate`/`scale` (about its
  `transform-origin`) is applied from computed style (`boxAffine`), since
  there's no rect to solve a translation from. `counter()`/`counters()`
  and quote keywords come from `dom/generated.ts` (one document walk per
  read, only when some content needs it); `url()` content and
  `list-style-image` become ImageRecords (an image after text rides in a
  synthetic non-context node, since ElKid has no image).
- **Blend modes** (`scene/blend.ts`, `gpu/blend.ts`): `mix-blend-mode`
  `multiply`/`screen`/`plus-lighter`/`exclusion`/`difference` (the last as
  exclusion) are built-in materials with no hooks and their own blend
  state (`MaterialBinding.blend`), registered at init (`builtin`, skipped by
  `Scene.assign`). The reader tags records directly (`ElNode.blend`,
  inherited; pseudo items), per record, unless the element's records
  overlap: then its context is a group composited with the mode
  (`OpacityGroup.blend`, `GroupCompositor` per-mode pipelines) and its
  subtree is untagged. An `/fx` Material's tag replaces it and is undone
  back to it.
- **Image atlas.** Static `<img>`/background sources ≤1024px are packed into
  one mipmapped `rgba8unorm` atlas (`images/imageAtlas.ts`, 4px gutters,
  entries at 16px-aligned origins so mips 1-4 don't depend on packing, UVs
  clamped by a half texel in the shader); canvas/video and larger images keep
  their own texture. `ImagePass.draw` collapses consecutive atlas-backed
  instances into one call. `draw()` returns the number of GPU draws issued
  (`stats().draws`). Mip generation lives in `gpu/mips.ts`. Eviction:
  `ImagePass.upload` starts a round (`atlas.beginUse`) and every lookup
  marks its entry; when an entry doesn't fit at the largest size, entries
  unused in the last two rounds are dropped and the rest repacked by
  texture copy (rects move, `generation` bumps, and an upload that saw it
  happen runs again). Standalone textures not drawn for 10 s are destroyed
  (`TEXTURE_IDLE_MS`). `npm run test:atlas` checks the atlas in a page
  (`playground/atlas.html`).
- **Vector svgs (paths).** An inline svg root with `data-gpu-vector` or
  `data-gpu-morph` becomes one `PathRecord` per painted shape
  (`dom/svg_paths.ts`): its outline flattened to line segments (0.2
  device px) in path space (the svg's viewport via `getCTM`), solid
  fill / stroke only; anything else returns null and the svg is
  rasterised as below. `paths/path_pass.ts` (layer `'paths'`) fills by
  winding and strokes by distance (`paths/path_wgsl.ts`, shared with
  the morph engine); records over 256 edges get row bands. Path
  records take no materials (`tagBlend` skips them; a blended svg is
  rasterised).
  An `<img data-gpu-vector>` (or data-gpu-morph) of an svg file baked
  into the asset manifest draws the same way (M5f; `readImgPaths`): the
  `.cgv` file (`assets/vector_file.ts`, written by `tools/bake_svg.ts`)
  holds each shape's matrix, paint and outline as a path tape
  (`paths/path_data.ts`: the PathSink calls parsing made), replayed into
  Flat at the on-screen scale, so it equals the inline svg exactly.
  `assets/vectors.ts` (VectorStore, `reader.vectors`) looks imgs up by
  resolved src and loads files on first use (the img draws nothing
  meanwhile; `mirrorComplete` waits).
- **Inline SVG and SVG images.** An inline `<svg>` root becomes one
  ImageRecord (`dom/svg.ts`: cloned, computed `color`/`fill`/`stroke` baked
  in, serialised to a `data:` URL, cached by FNV-1a hash of markup+size); its
  subtree is never walked. SVG sources are rasterised at their CSS concrete
  object size (object-fit against the intrinsic ratio), never natural size
  (a 2560² gatsby sizer took seconds); a `data:` SVG is re-serialised at
  that size and decoded async, so its preserveAspectRatio places the
  content as the browser does (canvas drawImage would stretch Chrome's
  default 300×150; `images/svgRaster.ts`). Plain `<img>` sources go
  through `createImageBitmap` because `naturalWidth` is density-corrected for
  `srcset` images while the decoded bitmap is not. They are decoded from a
  Blob re-fetched with the normal cache rules (`images/decode.ts`; never
  `force-cache`, which served a replaced cross-origin image's old bytes):
  `createImageBitmap(img)` decodes synchronously on the main thread
  (`img.decode()` first doesn't help), the Blob path off it; sources fetch
  can't read fall back to the element, except a cross-origin `<img>`
  without a `crossorigin` attribute, which is tainted either way
  (`OpaqueImageError`): the compositor sets `data-gpu-ignore="cross-origin"`
  on it, so it becomes a cutout the page paints through (and stays painted
  in replace mode), and removes the attribute when it loads another source
  or on `destroy()`. Cross-origin background `url()`s without CORS are
  logged and not drawn. With `imageFadeIn` (ms, default 0) a decoded
  source that arrives after the handoff fades in from its first upload
  (`images/image_fade.ts`, scaling the instance opacity; the image layer
  is dirtied and the loop kept running while one is active); off under
  `prefers-reduced-motion: reduce`. Borders are per side
  (`border.widths`/`colors`, mitred in the shader).
- **Opacity groups.** A context with `opacity < 1` is an `OpacityGroup`
  (paint-order range + alpha + doc-space bounds, `scene.groups`). The batch
  list carries `push`/`pop` markers at its cuts. `Renderer.render` runs in
  two phases: first every group's range is rendered into a pooled offscreen
  texture (own Frame uniform: viewport = texture size, scroll = group
  origin), children before parents, each in its own pass; then each
  target's single pass draws its batches and composites its child groups
  at their push (`compositeGroup`; `gpu/composite.ts` draws a quad of four
  corners with the group alpha). A parent's leaf groups (nothing nested,
  no backdrop or extra layer inside, no layer transform, region, blur or
  drop shadow) share one texture and pass instead (`renderLeaves`,
  `packGroups`: shelf-packed with a 2 px gutter, each drawn in its rect
  with its own frame and scissor, composited from its `uv0`; the pooled
  texture's `refs` keep it in use until the last composite);
  `groupAtlas: false` (`?noatlas`, `--noatlas`) gives each its own.
  What happens to each group is decided one target at a time by
  `gpu/group_plan.ts` (`planLevel`, pure: in place, skipped outside the
  band, a leaf, or its own texture with blur / drop shadows / a region
  pass, plus the leaves' packing); the renderer plans a target's children
  once its pooled texture is acquired, then encodes;
  `stats().groupPasses` counts the passes. A group rendered into its own
  texture keeps it between frames while its signature matches
  (`gpu/group_cache.ts`: keyed by element via `cacheKey`, a hash of its
  `GroupPlace`, blur, shadows and the content of every record and nested
  push inside: records aren't mutated, so each one's hash is memoized;
  `id` and `z` are left out, so a re-read rebuilding an unchanged element
  matches). Each frame notes why each group was rendered afresh
  (`FrameWhy.groups`, the report's "group textures a frame" line).
  Transformed groups are kept too: their texture is in local space, so
  it's signed by `GroupPlace` (incl. `kx/ky`), not the affine; while a
  scale changes, `PlanInput.scaleOf` rounds it up to 1/8 octave
  (`stepUp`) and it's drawn exactly after holding SCALE_SETTLE frames
  (`scaleSettling` keeps the loop and the layers' rows live until then);
  `clipGrid` rounds the cut to the parent out to 256 device px. A leaf
  unchanged two frames running leaves the atlas for a kept texture
  (`steady`). Keys are per frame unique (`keyOf`). A material batch signs with
  `Renderer.materialKey`: a constant while the material is off or its
  `reach()` (MaterialEntry, from MaterialOptions.reach) misses the
  group's untransformed box in viewport px, else its `version` (bumped
  each frame `changed()`); no `changed` means it can't be kept. Scale
  and cut rounding applies to every transformed group, kept or not
  (children's placement follows their parent's). keyOf gives an
  element's further groups in a frame stand-in keys kept per element
  and order (not reader nodes, which re-reads replace).
  Anything that changes without a new record makes a group uncacheable
  (dynamic images, materials, extras, nested xf/region, viewport space,
  image fades, `onGlyph`), and nothing is kept until `cacheReady` (fonts,
  faces, vectors, images and material pipelines loaded). Kept textures
  are `GroupTarget.held`, out of the pool; `groupCache: false` disables.
  The main pass is split only at a
  backdrop (below). Records
  therefore carry `opacity = 1`; passes stay unaware. A context with a
  CSS `filter` is a group too (`scene/filter.ts`): its colour functions
  are 4×5 matrices the composite applies in order, clamped after each
  (`mats` storage buffer; an instance with none takes the plain path),
  and `blur()` runs two Gaussian passes over the group texture
  (`gpu/groupBlur.ts`) after its records, with `bounds` grown by 3σ.
  `isolation: isolate` makes a group only when something inside blends.
  `drop-shadow()` is drawn by `Renderer.shadowGroup` (after the blur,
  before the colour functions). `backdrop-filter` (blur and colour
  functions) is a `BackdropRecord` painted first among the element's own
  records, reached through a `backdrop` batch at its z (before its own
  group's push): `Renderer.drawBackdrop` ends the target's pass, blurs
  the region under the border box (+3σ) from the target into a pooled
  texture, resumes the pass (`load`) and draws it inside the element's
  rounded, transformed shape (`gpu/backdrop.ts`, colour functions there).
  The backdrop is what the target holds, so the nearest opacity, filter
  or layer-transform group is the backdrop root; the element's own
  opacity doesn't fade it. The canvas is reconfigured with
  TEXTURE_BINDING the first time a backdrop appears.
  Not drawn: `url()`; `multiply` inside an isolated group
  over transparent pixels comes out black (its blend state assumes an
  opaque backdrop).
- **Layer transforms** (`graph.transform`, `/fx` `fx.transform`): an
  element isolated like a region (shared id; `node.regionClip`, the
  group's `box`/`clip`/`space`) whose group is composited through a
  per-frame affine (`layerAffine`: translate, rotate, scale about an origin
  in its box) with an extra opacity, scissored to its ancestors' clip AABB.
  The group texture renders at the transform's axis scales (`axisScales`,
  1/16..4 × the parent's resolution; the group Frame's `dpr` scales with
  it for Slug's pad) and, without rotation, the composite quad snaps to
  the parent's pixel grid, so it lands 1:1 and stays crisp.
  At identity and opacity 1 the group draws in place (`plan` 'in-place':
  pixel-identical, no texture). Under a transform `openGroup` renders the
  part that can land in the parent (parent ∩ clip, mapped back), and
  `growExtents` grows enclosing groups to where transformed descendants
  land. No DOM writes, so no re-reads: the CSS-transform route costs a
  full read per frame on the perf page.
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
  read of its parent. Replace mode leaves ignored elements painting,
  including ones added or marked after the handoff (`reconcileHidden` in
  `compositor.ts` re-splits the hidden set on childList and
  `data-gpu-ignore` changes). An
  ignored element whose outermost stacking context has a z-index above
  the canvas's (`CompositorOptions.zIndex`, `SceneReader.canvasZ`) gets no
  hole: the page paints it over the canvas anyway, and a hole for a fixed
  element trails it while scrolling (placed at frame time, the canvas
  scrolls with the page). Only when no ancestor of the root makes a
  real stacking context (`rootInRootContext`; a positioned z-auto `body`
  doesn't count).
- **Outlines** (`readOutline` in `dom/styles.ts`): a border-only BoxRecord
  grown by `outline-offset + outline-width` in local space, radii `r + e`
  where r > 0, appended after the element's kids (over its content, under
  later siblings), clipped by ancestors only. `auto` draws solid. Focus
  changes no attribute, so `DomSync` re-reads the target's parent on
  `focusin`/`focusout` (`:focus-visible` rings).
- Instance buffers are `StorageArray`s (`gpu/storage.ts`): `ensure(n)` grows
  by doubling and returns true when the buffer was recreated (rebuild the
  bind groups that reference it); `write(first, count)` uploads only those
  items.
- A record pass's pipelines are a `PassPipelines` (`gpu/material.ts`): it
  assembles the shader (`passShader`: Frame, material interface, the
  hooks, then the pass's `body`), builds the default pipeline and each
  material's variant, and at draw time `use(encoder, material)` sets the
  pipeline and bind group 2 and returns the vertex count (null: a held
  material, draw nothing; `pipelineFor` when a pass interleaves pipelines,
  as Slug does with its atlas).
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
   (on, also under a transform: lines and widths are measured in the
   element's local frame and placed through its linear part, `frameOf`/
   `pushPlaced`) it takes far fewer rects: one
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
   row bands, then 16 column bands whose curves are stored x/y-swapped. It reads `glyph.path` (font units, y-up) — *not*
   `getPath()`, which is y-down and baseline-relative and silently produces
   nothing. This trap has already been hit once (commit 602d3e3).
3. `rasterizer.ts` (`SlugText`) packs bands + curves into storage buffers once
   per font and one 16-float instance per on-screen glyph. The instance quad is
   the glyph's **ink box**, derived from ascender/descender metrics and the
   grapheme's line box — not the line box itself — so outlines aren't stretched.
   The vertex shader grows the quad by a device pixel per side (em extends
   past [0,1]) so the AA fringe outside the outline isn't clipped; without
   it, stems at the ink box's edge (l, i) render thin.
4. `shaders.ts` (`slug_coverage`, shared with `/fx` Layers) casts Slug's
   two rays, horizontal through the row band and vertical through the
   column band, each as two rays a quarter pixel either side of the centre,
   and blends them by their weights; `SLUG_GAMMA` (0.87) thickens edges to
   match Chrome's weight. No atlas, no resolution ceiling.
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
`TextBackend`. `FontFace` doesn't expose its bytes, so `prepare(FontFace[])`
matches each face to an `@font-face` rule and fetches its `url()`
(`text/font_source.ts`); with `fonts: 'auto'` the compositor prepares the
faces the browser has loaded or is loading, then each face on
`loadingdone`, so unused faces are never fetched. Bytes can also be handed
over with `compositor.text.loadFontBuffer()` (queued until opentype.js has
loaded; `onFace` then re-reads).

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

- Filenames should be lower snake case (ie: `text_rasterizer.ts` not `TextRasterizer.ts`)
## Git workflow

Never commit on your own. Make changes and leave them uncommitted so I can
review the diff; I decide when to commit.
