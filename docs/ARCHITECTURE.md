# compositor-gpu — Architecture & Spec

> A drop-in library that mirrors a live web page onto the GPU — every box,
> image and glyph — kept in step with the DOM and the CSS you already wrote,
> so you can run shaders over real, accessible HTML. Glyphs are painted from
> the font's own outlines with the **Slug** algorithm: sharp at any size, no
> texture atlas, every letter individually addressable.

Status: **spec + scaffold**. This document is the source of truth for what we
are building and why. Code under `src/` implements it incrementally (see
`ROADMAP.md`).

---

## 1. The core idea

The DOM stays the **source of truth for layout**. We never re-implement CSS
layout, line-breaking, shaping, kerning, or flexbox. The browser does all of
that, invisibly, exactly as it does today. We then **read back** the resulting
geometry (element boxes, image rects, per-glyph rects) and mirror each piece
onto the GPU as instanced geometry, which we keep in sync as the page scrolls,
resizes, reflows, or mutates.

This buys three things:

1. **Fidelity for free.** Because we consume the browser's own layout, the GPU
   copy matches the page's fonts, weights, sizes, tracking, leading, line
   breaks and colours with zero layout code of our own.
2. **Accessibility for free.** The real DOM is still there — selectable,
   focusable, screen-reader friendly, SEO-visible. The GPU layer is a *paint
   surface*, not a replacement. If WebGPU is unavailable, the page is simply
   itself.
3. **A shader hook over real content.** Once content lives on the GPU as
   per-element / per-glyph instances, you can displace, transition, ripple,
   or explode any of it independently, driven by scroll or pointer or time.

The mental model is a **compositor**: the browser paints to a hidden layer,
we composite a GPU mirror of it on top (or in place of it), and we own only
the pixels, never the layout.

### 1.1 Two coordinate worlds

- **Document space** — CSS pixels relative to the top-left of the document.
  Everything we read from the DOM (`getBoundingClientRect` + `scrollX/Y`) is
  normalised into document space so scrolling is a single uniform offset, not
  a re-read.
- **Clip space** — WebGPU NDC. The vertex shader maps document space →
  canvas space (subtract the canvas anchor) → clip space.

Keeping the scene in document space is what makes scrolling cheap: on scroll we
update **one uniform** at most, not thousands of instances.

**The anchored canvas.** The canvas is `position: absolute` on `<html>`, not
fixed: the browser's compositor thread scrolls it with the page, so the mirror
never trails the DOM by a frame. It is `viewW × min(viewH + 2·margin, docH)` CSS
px (`canvasMargin`, default one viewport height), placed at its **anchor**
(its document-space origin). When the viewport `[scrollY, scrollY + viewH)`
leaves `[anchorY, anchorY + canvasH)`, on any horizontal scroll, or on resize,
the frame re-anchors before rendering, in the same task:
`anchorY = clamp(scrollY - margin, 0, docH - canvasH)`, `anchorX = scrollX`.
It never extends past the document's scrollable size, so it never grows the
page. The Frame uniform's `viewport`/`scroll` are the canvas size and anchor;
`vscroll` (for `position: fixed` records, stored in viewport space) is
`anchor - scroll`. Fixed content is drawn where it is at frame time and moves
with the page until the next frame.

---

## 2. System overview

```
                         ┌─────────────────────────────────────────┐
   real DOM (truth) ───► │  Reader        walk + read computed      │
   (hidden or shown)     │                layout & style            │
                         │                  │                        │
                         │                  ▼                        │
                         │  Scene         records: Box / Image /     │
                         │                GlyphRun (document space)  │
                         │                  │                        │
   ResizeObserver ─────► │  Sync          diff + invalidate          │
   MutationObserver      │                  │                        │
   IntersectionObserver  │                  ▼                        │
   scroll / rAF          │  Renderer      TypeGPU device             │
   FontFace ready        │                ├─ BoxPass   (instanced)   │
                         │                ├─ ImagePass (textured)    │
                         │                ├─ TextPass  (Slug)        │
                         │                └─ CutoutPass (dest-out)   │
                         │                  │                        │
                         │                  ▼                        │
                         │         <canvas> (absolute, anchored)     │
                         └─────────────────────────────────────────┘
```

Data flows one way: **DOM → Reader → Scene → Renderer → canvas.** Observers only
*invalidate*; they never touch GPU state directly. A single rAF loop drains
invalidations, updates buffers, and draws.

---

## 3. Modules

| Module | Responsibility |
| --- | --- |
| `compositor.ts` | Public lifecycle: `createCompositor()`, mount/unmount, start/stop, options. Owns the rAF loop and wires everything together. |
| `gpu/device.ts` | WebGPU adapter/device init via **TypeGPU**, canvas configuration, resize, DPR, feature detection + graceful bail. |
| `gpu/renderer.ts` | Frame orchestration: begins a render pass, runs each enabled pass, submits. Holds shared uniforms (canvas size, canvas anchor, time). |
| `dom/tree.ts` | Persistent element tree reader: fullRead() walks the DOM and rebuilds the tree; partialRead(scopes) re-reads only the subtrees a mutation could have changed. Escalates to a full read when a mutated element's border-box rect changes (siblings could move). |
| `dom/styles.ts` | Reads `getComputedStyle` and normalises the subset we paint (background, border-radius, colour, opacity, transform, clip, z-order). |
| `dom/gradient.ts` | Reads CSS `linear-gradient` and `radial-gradient`, interpolates in premultiplied sRGB. |
| `dom/backgrounds.ts` | Reads `background-image: url()`, `background-size` / `background-position`; handles async loading with scoped re-read. |
| `dom/transform.ts` | Recovers each record's local (untransformed) size and 2×3 affine from the computed transform chain and the measured AABB; drives transformed boxes/images/glyphs and synthetic oblique. |
| `dom/decorations.ts` | Reads `text-decoration`, propagates it across in-flow descendants, and turns it into per-line-fragment BoxRecords (with skip-ink) painted just before a run's glyphs. |
| `dom/pseudo.ts` | Synthesises `::marker`/`::before`/`::after` records from computed pseudo style plus measured/Chrome-reported geometry; anchored into the host's local frame. |
| `dom/gradient.ts` | Reads CSS `linear-gradient`/`radial-gradient`, interpolates stops in premultiplied sRGB for the box shader. |
| `dom/textRuns.ts` | Extracts per-glyph geometry from text nodes using `Range.getClientRects()` / segmentation, mapped to font + colour. The heart of text fidelity. |
| `dom/observer.ts` | Resize/Mutation/Intersection observers + scroll + `document.fonts.ready`; coalesces into invalidation flags. |
| `scene/records.ts` | Plain data records (`BoxRecord`, `ImageRecord`, `GlyphRun`, `CutoutRecord`) in document space. No GPU types here. |
| `scene/scene.ts` | Holds records, assigns stable ids, produces instance buffers, tracks dirty ranges. |
| `scene/stacking.ts` | Builds a simplified CSS stacking-context tree while walking and flattens it (Appendix E) into each record's integer paint order `z`; also produces opacity `OpacityGroup`s. |
| `scene/batches.ts` | Merges boxes/images/text/cutouts into cross-layer draw batches (splitting only where overlap forces it) and threads in push/pop markers for opacity groups. |
| `text/textRasterizer.ts` | Interface a text backend must satisfy (`Slug` is the default impl; an MSDF impl can slot in). |
| `text/slug/*` | Font outline extraction → banded curve data → GPU buffers; the Slug WGSL fragment shader. |
| `text/glyphAtlas.ts` | Canvas-2D-rasterised fallback atlas (emoji, uncovered code points, multi-code-point clusters, unregistered faces), packed as a shared `rgba8unorm` texture. |
| `text/atlasShader.ts` | Second pipeline in the text pass drawing textured quads from the fallback atlas, sharing one instance index space with Slug so cross-layer batches stay aligned. |
| `text/fontSource.ts` | Resolves a `FontFace`/`@font-face` rule to its `url()` source and fetches the bytes at runtime for `SlugText.prepare()`. |
| `boxes/boxRenderer.ts` | Instanced rounded-rect pass (backgrounds, borders, gradients, shadows). The simplest full vertical slice of the sync loop. |
| `boxes/cutoutPass.ts` | Erases the mirror under `data-gpu-ignore` elements: one rounded-rect quad per `CutoutRecord`, blended destination-out at the record's paint-order position, so the page's own paint of the ignored element shows through the canvas. |
| `images/imageRenderer.ts` | Uploads `<img>` / `<canvas>` / `<video>` / background images to textures, draws textured quads; collapses consecutive atlas-backed instances into one draw. |
| `images/imageAtlas.ts` | Shared mipmapped `rgba8unorm` atlas for static images ≤1024px (4px gutters, half-texel-clamped UVs); larger/dynamic images keep their own texture. |
| `gpu/frame.ts` | Shared `Frame` uniform (target size, target origin, time, dpr, vscroll) and `doc_to_clip()`, prepended to every pass's WGSL; bind group 0 for all passes. |
| `gpu/composite.ts` | Offscreen texture pool + pipeline that draws a completed opacity group's texture back into its parent target at the group's doc-space rect, scaled by group alpha. |
| `gpu/mips.ts` | Mip-chain generation (fullscreen-triangle blit pipeline) for static image/atlas textures. |
| `util/*` | rAF scheduler, logging, small math (mat, rect). |

---

## 4. The text pipeline (Slug)

This is the marquee feature and the reason the project exists. Sequence:

1. **Discover text.** The walker yields each text-bearing node. For each, we
   create a `Range` over its characters.
2. **Segment into glyphs.** `Range.getClientRects()` gives one rect per line
   fragment; combined with `Intl.Segmenter` (grapheme) and per-character range
   rects we resolve **per-glyph boxes** in document space. This inherits the
   browser's shaping, kerning, bidi and line breaks.
3. **Resolve font + paint.** From computed style we get family, weight, style,
   size, colour, letter-spacing. We map (family, weight, style) → a loaded font
   resource.
4. **Font → outlines → bands.** Each needed glyph's outline (quadratic for
   TrueType, cubic→quadratic reduced for CFF) is extracted once and packed into
   Slug's **banded curve** layout: the em is sliced into horizontal bands, each
   band holds the curves crossing it, sorted for front-to-back winding
   evaluation. Cached per (font, glyph).
5. **Instance per glyph.** Each visible glyph becomes one instanced quad.
   Per-instance data: document-space position + size, glyph id (→ band table
   offset), colour, and a free `perturb`/`transform` slot so **every letter can
   move on its own**.
6. **Shade.** The fragment shader computes a winding number per pixel by testing
   the pixel against the band's Bézier curves, with analytic anti-aliasing
   (coverage from the horizontal distance to each curve crossing). Sharp at any
   scale and under perspective, because it evaluates the real outline — no atlas,
   no resolution ceiling, no glyph budget.

Slug's patent was dedicated to the public domain (March 2026); reference
shaders are MIT. We adapt those rather than deriving from scratch. See
`text/slug/README.md` for the data-layout details and shader provenance.

**Fallback atlas.** Slug needs outline bytes; the browser doesn't. Graphemes
Slug can't draw — emoji and other colour glyphs, code points missing from the
loaded face, multi-code-point clusters, or a run whose family has no registered
face — are rasterised by Canvas 2D with the run's font stack into a shared
atlas (`text/glyphAtlas.ts`) and drawn as textured quads by a second pipeline
in the text pass. The two pipelines share one instance index space so the
cross-layer draw batches stay valid. The atlas is a real fallback, not the
default: it's resolution-bound and greyscale-AA, but it makes text visible
before fonts load and gives emoji the platform's own colour font.

**Alternative backend.** `textRasterizer.ts` is an interface. A lighter
**MSDF** backend (pre-baked atlas, one draw call) can be dropped in for
constrained targets.

### 4.1 Why not just re-shape text ourselves?
Because HarfBuzz-in-WASM + a layout engine is a multi-month rabbit hole and
would still diverge from what the browser renders. Reading the browser's own
rects is the whole trick behind "perfectly replicating the HTML text."

### 4.2 Known hard edges
- `getClientRects()` at glyph granularity is a **forced-reflow** trap. All DOM
  reads are batched at the top of a frame, before any write; results are cached
  and only re-read on invalidation. Never read inside the render loop.
- Sub-pixel positioning and hinting differ across browsers; we accept the
  browser's rect as ground truth and centre the outline within it.
- Emoji and other colour glyphs render via the Canvas 2D fallback atlas
  (`text/glyphAtlas.ts`), not by leaving them in the DOM. What's out of scope
  is native COLR/CBDT rasterisation inside Slug's own outline shader.

---

## 5. Boxes and images

- **Boxes.** Backgrounds, borders and radii become instanced rounded-rect
  quads (SDF rounded-box in the fragment shader). Per-instance: rect, radius,
  fill, border width/colour, opacity. This is the smallest end-to-end proof of
  the sync loop and lands first.
- **Images.** `<img>`, `<canvas>`, `<video>`, and `background-image` become
  textured quads. `object-fit` maps to UV; `background-image: url()` supports
  `background-size` (cover/contain/auto) and `background-position`. Static
  images ≤1024px are packed into one shared mipmapped atlas
  (`images/imageAtlas.ts`); `<canvas>`/`<video>` sources and larger images
  keep their own texture, re-uploaded per frame when dynamic. `ImagePass`
  collapses consecutive atlas-backed instances into one draw call.
- **Stacking.** The walker builds a simplified CSS stacking-context tree
  (`scene/stacking.ts`: positioned+z-index, fixed/sticky, opacity<1,
  transform, isolation, filter, blend mode) and flattens it per Appendix E
  into one integer paint order per record. Because boxes, images and text are
  separate pipelines, `scene/batches.ts` merges the three lists into
  cross-layer draw batches: layers are only split where a later record
  actually overlaps an earlier one, so a flat page stays at ~3 draw calls and a
  z-indexed overlay costs a couple more. An `opacity < 1` context is an
  isolated group: the batch list carries push/pop markers, the renderer draws
  the range into a pooled offscreen texture and composites it back once with
  the group alpha (`gpu/composite.ts`), so overlapping children don't
  double-blend. Blend modes and filters are follow-ups. `overflow: hidden` is a
  per-instance clip rect.

---

## 6. The sync loop

```
on any observer fire ─► set dirty flags (LAYOUT | STYLE | CONTENT | MUTATION | SCROLL)
                        request a frame (rAF), coalesced

frame():
  if LAYOUT|STYLE|CONTENT:  reader.fullRead()              // batched DOM reads,
                                                            // rebuilds the scene
  else if MUTATION:         reader.partialRead(scopes)      // re-read boundaries
                            (escalates to a full read if a boundary's rect changed;
                             running CSS transitions/animations add their parent
                             scopes every frame while they run)
  place(scroll)                                             // re-anchor the canvas
                                                            // if the viewport left it
  renderer.render(scene, ctx, dpr)                          // writes the Frame
                                                            // uniform (canvas size,
                                                            // anchor, time, dpr),
                                                            // uploads only dirty
                                                            // layers, walks
                                                            // scene.batches
                                                            // (push/pop opacity
                                                            // groups render
                                                            // offscreen + composite)
                                                            // and submits
```

- **ResizeObserver** on the root (and key subtrees) → LAYOUT.
- **MutationObserver** (childList, characterData, attributes: style/class) →
  MUTATION, scoped to the mutated subtree's boundaries; escalates to a full read
  if a boundary's border-box rect changed.
- **IntersectionObserver** → cull offscreen records cheaply; only on-screen
  instances are drawn.
- **scroll** (passive) → SCROLL only (no re-read): rAF frames run until the
  scroll settles; each re-anchors the canvas if the viewport left it and
  re-reads moved sticky elements, paint-only.
- **`document.fonts.ready`** and `FontFace` load events → invalidate text.
- **DPR / media changes** → reconfigure canvas.

Everything is **coalesced to one rAF**: N observer fires in a frame cause at
most one re-read and one draw.

---

## 7. Public API (target)

```ts
import { createCompositor } from 'compositor-gpu'

const compositor = await createCompositor({
  root: document.body,          // subtree to mirror
  mode: 'overlay',              // 'overlay' | 'replace'
  layers: ['boxes','images','text'],
  hideSource: false,            // 'replace' hides DOM paint but keeps a11y
  fonts: 'auto',                // 'auto' = discover from document.fonts
  onGlyph: (g) => {             // per-glyph hook for effects
    g.offset.y = Math.sin(performance.now()/300 + g.index) * 4
  },
  fallback: 'passthrough',      // if no WebGPU: do nothing, DOM stays
})

compositor.start()
// ...
compositor.invalidate()          // force a re-read + re-upload
compositor.setSourceHidden(true) // toggle replace-mode hiding, reversibly
compositor.stop()
compositor.destroy()
```

- **`mode: 'overlay'`** paints the GPU mirror over the page (for effects that
  read the page as-is). **`mode: 'replace'`** sets the mirrored root's
  `style.opacity` to `0` (saving and restoring the previous value) — layout,
  focus, selection, hit-testing and the a11y tree are all untouched, only the
  painted pixels disappear — and shows only the GPU version, the DomGL-style
  "your DOM, on the GPU" experience. `hideSource: false` skips that opacity
  flip (both DOM and GPU paint stacked).
- **`fonts`**: omitted or `'auto'` discovers every face already registered on
  `document.fonts`; an explicit `FontFace[]` resolves only those. Either way
  the bytes are fetched at runtime from the face's `@font-face` `url()`
  (`text/fontSource.ts`), not supplied inline.
- Framework-agnostic. React/Gatsby usage is a thin client-only wrapper (see
  `INTEGRATION.md`).
- Zero required peer deps beyond **TypeGPU**; no framework assumed.

The returned `Compositor` also exposes:

- **`canvas`** — the mirror `HTMLCanvasElement` (absolutely positioned on
  `<html>`, see §1.1), or `null` in passthrough/inert.
- **`active`** — `true` once a real GPU pipeline is running (`false` in passthrough).
- **`invalidate()`** — force a full re-read of the DOM and re-upload of every layer.
- **`setSourceHidden(hidden)`** — toggle the `replace`-mode opacity flip directly.
- **`stats()`** — live counts for debug overlays, returning a `CompositorStats`:
  `active`, `boxes`, `images`, `glyphs`, `fallback` (atlas-drawn glyphs),
  `ligatures`, `uploads` (layers re-uploaded), `batches`, `draws` (actual
  `encoder.draw` calls, lower than `batches` when atlas-backed image instances
  collapse into one call), `groups` (opacity groups composited), `readElements`,
  `partialReads`, `readMs`, `uploadMs`, `encodeMs`, `fps`, `anchorX`/`anchorY`
  (the canvas's document-space origin) and `reanchors` (cumulative).

---

## 8. Design constraints

- **Dependency-light.** TypeGPU for the WebGPU layer; a font parser
  (`opentype.js` or a trimmed in-house glyf/CFF reader) for outlines. Nothing
  else in the hot path. No React, no three.js.
- **WebGPU-first, graceful bail.** Feature-detect; if absent, `fallback` decides
  (default: passthrough — the untouched page). A WebGL2 backend is possible
  later behind the same renderer interface but is **not** a v1 goal.
- **SSR-safe.** All DOM/GPU work is client-only and lazy; importing the package
  on the server must be inert (matters for Gatsby/`/duo`).
- **No layout ownership.** If a feature would require us to compute layout, it's
  out of scope. We read, we don't lay out.
- **One canvas, one device, one loop.** Multiple compositors share nothing and
  must be cheap to spin up/tear down.

---

## 9. Performance budget

- Scroll must be **uniform-only** (no per-frame DOM reads, no instance rewrites).
- Target: 10k+ glyphs on screen at 120fps on Apple Silicon; degrade by culling.
- All DOM reads batched into a single measured phase per invalidated frame.
- Glyph band data cached across instances of the same glyph; upload deltas only.
- Instance buffers use ring/sub-allocation to avoid per-frame reallocation.

---

## 10. Testing strategy

- **Playground** (`playground/`) — plain HTML page, no framework, to iterate on
  the renderer against real text/boxes/images.
- **`/duo` in mds-home** — the integration test bed: mount the compositor over a
  real Gatsby page behind a flag, verify SSR-safety, a11y passthrough, and that
  turning it off leaves the page pixel-identical.
- **Visual regression** — screenshot the GPU layer vs. the DOM paint and diff
  (later; needs a browser harness).
- No unit-test framework; correctness of the shader is validated by the
  visual-regression harness (`npm run test:visual`, Playwright + pixelmatch)
  and offline WGSL validation with `naga`. Headless WebGPU does run in a
  sandbox with no GPU: the harness tries the real adapter first and falls
  back to SwiftShader.

---

## 11. Out of scope for v1

Colour/emoji glyphs render fine — they go through the Canvas 2D fallback
atlas (`text/glyphAtlas.ts`) like any other grapheme Slug can't draw. What's
out of scope is *native* COLR/CBDT rasterisation inside Slug itself (drawing
the colour layers from the font's own outlines rather than falling back to
Canvas 2D).

Also out of scope: CSS filters/blend modes/mix-blend; 3D transforms &
perspective on boxes (text under perspective *is* supported by Slug, since it
positions with a real 2×3 affine); nested scroll containers with independent
scroll; print; a WebGL2 fallback path. All are tracked as v2+ in
`ROADMAP.md`.
