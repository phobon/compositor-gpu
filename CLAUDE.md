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

Vite has two modes (`vite.config.ts`): `serve` roots at `playground/`, `build`
bundles `src/index.ts` as an ES library with `typegpu` and `opentype.js`
external. `@/*` aliases `src/*` in both tsconfig and vite.

## Status

`ROADMAP.md` is the live checklist and `docs/ARCHITECTURE.md` is the spec — the
spec describes the target, not all of which is built. Currently real: the box
pass (a complete DOM→GPU vertical slice) and the Slug text pass (font pipeline +
WGSL, rendering but still being tuned). `ImagePass` renders `<img>`, `<canvas>`,
`<video>` and `background-image url()` with mipmaps and rounded clipping;
gradients live in the box pass. Read `ROADMAP.md` before assuming a feature is missing by accident.

## Architecture

Data flows one way: **DOM → reader → Scene → RenderPass → canvas.** Observers
only set dirty flags; they never touch GPU state. One rAF drains them.

### Two coordinate spaces
Everything in `scene/records.ts` is in **document space** (CSS px from the
document's top-left: `getBoundingClientRect()` + `scrollX/Y`, via
`toDocRect`). `doc_to_clip()` in `gpu/frame.ts` maps that to clip space in the
vertex shader. This is the load-bearing decision: **scrolling writes one uniform
and re-reads nothing.** Never store viewport-relative coordinates in a record,
and never make scroll a reason to re-walk the DOM.

### The frame
`compositor.ts` owns the loop. Per frame: take dirty flags → if
LAYOUT/STYLE/CONTENT call `SceneReader.fullRead()`, if MUTATION call
`partialRead(scopes)` (the only places DOM layout is read) in `dom/tree.ts` → run
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
   bidi and line breaking are inherited for free. `glyphId` is currently the
   grapheme's **first code point**, not a real glyph index; `SlugText` remaps it
   through the font cmap. Ligatures are therefore approximate.
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
