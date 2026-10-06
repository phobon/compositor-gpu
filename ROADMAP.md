# Roadmap

## Where to pick up (2026-10-03)

**State.** Mirror: Phases 0–2 complete, Phase 3 largely done, mounted on
bonobolabs.com `/duo?gpu=1` from the `compositor-gpu` submodule (`&stats=1`
readout, `&debug=1` logging, `&mode=replace`). Site chrome is
`data-gpu-ignore`d: in-flow chrome shows through cutout holes, fixed chrome
sits above the canvas (`zIndex: 500`). Effects layer: spec in
`docs/EFFECTS.md`, M1, M2 and M3 built (`compositor-gpu/fx`:
Params, pointer, fullscreen and region Passes, Targets, Layers (with
`simulate`, `image`, `glyphs`), Materials (with `raw`), TypeGPU externals,
presets `blur`/`displace`/`cursorGlow`/`clickRipple`/`ripple`). `docs/HANDOFF.md` has the checkouts,
the last batch's verification and the first move on each item. Every harness passes
on the current tree:

- `npm run test:visual` — 28 shots (incl. `borderfill`, `texttransform`, `shapes`,
  `duo`/`duo-s900` full-viewport), DOM-vs-GPU parity 0.06–1.06% (images 2.9%
  from resampling). `-- --with-fx` installs `/fx` with no pass and must
  match the plain goldens at 0.00. Goldens are local + GPU-specific: run
  `-- --update` once on a new machine.
- `npm run test:fx` — effects goldens (`fx-off`, `fx-tgpu`, `fx-blur`,
  `fx-blur-scissor`, `fx-displace`, `fx-displace-push`,
  `fx-blur-then-off` ≡ `fx-off`, `fx-geometry`, `fx-glow`, `fx-ripple`,
  `fx-after`, `fx-region`, `fx-region-then-off` ≡ `fx-geometry`,
  `fx-materials`, `fx-mat-ripple`, `fx-mat-wave`, `fx-mat-bend` (+ DOM
  hidden check), `fx-mat-stripes`, `fx-mat-all`, `fx-mat-then-off` ≡
  `fx-materials`).
- `npm run test:perf` — 400-card page: full read ~425 ms (sandbox; 587 ms
  before `FAST_TEXT_READ`), partial read ~40 ms, encode 0.30 ms idle /
  0.40 ms with blur, 123 draws.
- `npm run test:site -- --url http://localhost:8000/duo` — ~1% at three
  offsets, clean console.

**Chrome on `/duo`**: read 0.6 ms idle, frame 0.3 ms, no fallback glyphs,
nothing invalidating the mirror at idle. **Safari**: read 2 ms, frame 1 ms.

**Next, in order.**
1. **Safari — closed.** The "scroll lock" and the 8 s stall on load were
   both gatsby develop's runtime-error overlay: a Safari extension's
   injected script does `parsed['@context'].toLowerCase()` on every
   `application/ld+json` block and threw on mds-home's array-form schema.
   Fixed in mds-home (`SEO.jsx` emits one `@graph` object); dev-only,
   never affected production. Safari now scrolls and loads cleanly with
   the compositor on. Perf item: Safari's full read was ~65× Chrome's
   (`Range.getBoundingClientRect` per grapheme, `frame 49 ms` steady state
   vs 0.7 ms). `FAST_TEXT_READ` (`dom/textRuns.ts`) now reads one
   `getClientRects()` per text node and splits lines into graphemes with
   Canvas 2D suffix widths, falling back to a Range per chunk, then per
   grapheme, wherever the widths don't match the browser's rects (0.05px).
   Measured in Chrome/SwiftShader: perf.html Range queries 84k → 15k per
   full read (12.9% of graphemes still per grapheme: rotated cards and
   16px opsz titles), text-node read alone ~2× faster, full read −26%
   (587 → 434 ms), the playground's `duo` section 0% per grapheme, visual
   regression 0.00% on every section. Not yet measured on Safari: re-run
   `/duo?gpu=1&stats=1` there and check `stats().textRead.perGrapheme`; if
   WebKit's canvas doesn't match its layout the width checks send every
   chunk per grapheme, and each font stops trying after 8 misses.
2. **Scroll-frame lag (overlay mode)** — done. The loop stays on rAF for
   `SCROLL_SETTLE_MS` after each `scroll` event, and the canvas scrolls with
   the document: `position: absolute`, the viewport plus `canvasMargin`
   (default one viewport height) above and below, re-anchored in the frame
   only when the viewport leaves it (`stats().anchorX/anchorY/reanchors`),
   so the compositor thread moves it in lockstep with the DOM. Fixed
   (viewport-space) content still moves with the page between frames. Cost:
   the canvas is up to 3× the viewport area; check fill rate on a real
   device (SwiftShader `steady fps` dropped ~5.5 → ~2 on `test:perf`).
3. **`mode: 'replace'` on the real page.** First interactive run showed a
   blank page: with `data-gpu-ignore` chrome present, replace mode hides
   the root's children with `opacity: 0` and the reader turned each into
   an opacity-0 group and skipped it. Fixed: hidden elements carry
   `data-gpu-hidden="<previous computed opacity>"`, which `readOpacity()`
   prefers (playground has an ignored badge so `test:site -- --replace`
   covers the path). The mirror painted `body`'s and the sections'
   backgrounds over ignored chrome, hiding it in both modes; ignored
   elements now leave a hole (`CutoutRecord`, `boxes/cutoutPass.ts`,
   destination-out at the element's paint-order position), exercised by
   the playground `duo` section (fixed nav, rounded overlap, a footer in
   an ignored `display: contents` wrapper as mds-home does it — the holes
   then land on the wrapper's children; attribute changes and CSS
   animations on a hole element re-read its parent). Fixed chrome goes
   above the canvas instead (`zIndex` option; mds-home passes 500): its
   hole would trail it by a frame while scrolling. Still to check
   interactively: hover/focus/selection,
   links, the nav popup.
4. **Remaining `/duo` gaps.** Border fill/snapping and `text-transform` /
   `letter-spacing`, dash phase and `url()` background clip/snapping are
   done (Phase 1/2/3). Open: `capitalize` context across text nodes and
   title-case mappings,
   `full-width` / `full-size-kana`, Greek final sigma under `lowercase`.
5. **Housekeeping.** Commit + push compositor-gpu, bump the submodule
   pointer in mds-home (`git -C compositor-gpu pull`), `git submodule`
   the local checkout back onto a clean HEAD; delete `_staging/` here and
   `_to_delete/` in mds-home; file the opentype.js gvar issue
   (`docs/UPSTREAM-gvar.md`, repro checked) so `text/slug/gvarFix.ts` can go.

**Effects layer** (`docs/EFFECTS.md`, spec settled 2026-10-01; `/fx`
entry point, three primitives — Pass, Material, Layer — over a shared
Params model, element-keyed Targets, a runtime pointer uniform):
- [x] M1 — runtime spine + post: render-graph hook (`gpu/graph.ts`:
      `RenderGraph`, `PostChain`, `FrameHook`), offscreen path only
      while a Pass is enabled, chain scissored to the visible viewport +
      max radius; `createEffects` (inert without a GPU); Params (schema,
      Proxy incl. element writes, std140-style packing, wake rules,
      time/elapsed); pointer (raw, smoothed velocity, eased follower,
      down, 8-click ring); fullscreen Pass taking WGSL or `tgpu.fn`;
      presets `blur`, `displace`; `playground/fx.html` + `npm run
      test:fx` goldens, no-effect invariants, `steady encode (blur)`
- [ ] M1 leftovers: `rollupTypes` emits per-file `.d.ts` (it did
      before `/fx` too: `@microsoft/api-extractor` isn't installed), so
      `exports['./fx'].types` points at `dist/fx/index.d.ts`. (JS-bodied
      `tgpu.fn` externals moved to M3; the copy-through under the
      scissored rect is gone.)
- [x] M2 — geometry: Target (lazy, element-keyed: rect/local/xform/
      space/radius, per-glyph arrays with stable indices); Layer
      (instanced quads from an author Float32Array, above / below = over
      the page background / after a target, doc or viewport space,
      `update` hook); extension point 3 (`graph.addLayer`, scene anchors
      → `extra` batch entries); region Pass (`fx.pass({ region })` on an
      isolated group, `graph.isolate`); presets `cursorGlow`,
      `clickRipple`; `displace` `mode` (lens / push); fx.html geometry
      section + 7 shots. Deviations in `docs/EFFECTS.md`.
- [x] M3a — materials: hook contract for box/image/glyph (`MatIn`,
      `mat_sample`), record passes templated around `mat_vertex` /
      `mat_fragment` (default variant pixel-identical), async per-material
      pipelines with default fallback, records tagged per batch build
      (`Scene.assign`) and batches cut by material, `subdivisions` (all
      kinds), per-target DOM hiding (`graph.hideSource`), preset
      `ripple`; fx.html materials section + 7 shots. Deviations in
      `docs/EFFECTS.md`.
- [x] M3b — Layer `simulate` compute hook (GPU-resident state,
      `markDirty(first, n)`, `fx.dt`/`steps`); `Target.image` + Layer
      `image` (`ImagePass.regionOf`, `graph.imageOf`); Layer `glyphs`
      through Slug's coverage (`SlugText.glyphTable`, shared
      `SLUG_COVERAGE_WGSL`); `raw` materials (`rawProgram`:
      `default_vs`/`default_fs`); TypeGPU externals (`gpu`, `MatIn`,
      `Quad`) and tgpu.fn hooks for layers and materials; fx.html M3b
      section + 9 shots. Deviations in `docs/EFFECTS.md`.

**Toolchain.** Deps were bumped (opentype.js 2, typegpu 0.12, TS 7 via the
TS6 shim, vite 8, biome 2.5, playwright 1.63); tsconfig/biome/vite configs are
migrated. `pnpm install` on macOS leaves no linux binaries, so checks can't run
in a Linux VM against that `node_modules`; git operations that take lock
files can't run there either.

**Open items by value** (details in the phase lists below): Web Animations API
tracking · `calt` alternates · atlas eviction ·
isolated groups for `filter`/`mix-blend-mode` · pseudo `counter()`/`url()` ·
perspective transforms · culling · WebGL2 backend.


## Phase 0 — scaffold (this commit)
- [x] Architecture spec (`docs/ARCHITECTURE.md`)
- [x] Repo tooling (TS, Vite lib build, Biome)
- [x] DOM→scene reader (walker, styles, per-glyph run extraction)
- [x] Coalesced observer/sync layer
- [x] TypeGPU device init + frame renderer + shared uniforms
- [x] **Box pass** — complete instanced rounded-rect vertical slice
- [x] Slug text pipeline scaffold (font→bands CPU path + WGSL)
- [x] Playground + `/duo` integration harness

## Phase 1 — text that renders
- [x] Validate the Slug shader in-browser; fix winding sign + band selection
- [x] Analytic anti-aliasing: Slug's dual rays (row + column bands), two
      rays per direction, coverage gamma 0.87 (text parity 0.95% -> 0.63%)
- [x] Resolve FontFace → bytes at runtime in `prepare()`
- [x] Ligatures via GSUB `liga`/`clig` matching (fi/fl/ffi/ffl); honours
      `font-variant-ligatures` / `"liga" 0`
- [ ] `calt` contextual alternates (Inter arrows), `dlig`; bidi verification
- [x] On-demand per-glyph band upload with an LRU
- [x] Match per-element font-weight/style to a registered face (family +
      nearest-weight + italic resolution; multiple static faces)
- [x] Derive faces from a variable font by instancing (avoid shipping N files)
- [x] `opsz`: variable faces are instanced per (weight, optical size), opsz =
      font-size under `font-optical-sizing: auto` — Inter's headings use the
      Display cut like the browser does
- [x] Glyph placement matches Blink: ascent/descent rounded to whole CSS px
      before the half-leading split, baseline snapped to a device pixel on
      untransformed runs (text section parity 4.05% -> 2.15%, body-text MAE
      halved). The harness now runs Chromium with `--disable-lcd-text` so the
      DOM capture is grayscale-AA like macOS; every text section moved.
- [x] `data-gpu-ignore` is honoured by `mode: 'replace'`: paint is hidden on
      the outermost elements that contain no ignored subtree, so excluded
      site chrome (nav, footer) keeps painting itself. `stats().frameMs` /
      `maxDtMs` (worst inter-frame gap in the last second) for hitch hunting.
- [x] Overlay mode lags the compositor-thread scroll by one frame (the GPU
      layer is repositioned from the `scroll` event, the DOM underneath by
      the browser's compositor): reads as shimmer/hitching while scrolling.
      Replace mode hides the double image; a canvas that scrolls with the
      document would remove the lag.
      Done: the frame loop now stays on rAF for `SCROLL_SETTLE_MS` (150)
      after each `scroll` event and renders with the current
      `scrollX/Y`, so 60 Hz events no longer halve a 120 Hz mirror
      (`stats().scrolling`; sticky re-reads only when the position moved).
      Then the canvas became `position: absolute` and document-scrolling
      (viewport plus `canvasMargin`, re-anchored in the frame when the
      viewport leaves it), so the browser's compositor moves it with the
      DOM and doc-space content no longer trails it.
- [x] `stats().fallbackSamples` (which graphemes hit the atlas and why) and
      `stats().sync` (why the mirror was invalidated, elements tracked as
      animating, last mutation target). `data-gpu-ignore` on an element
      excludes its subtree from the mirror and from invalidation — for debug
      overlays, site chrome and anything else that mutates every frame —
      and leaves a hole in the mirror (a `cutouts` layer, destination-out,
      at the element's z) so the page's own paint of it shows; an ignored
      `display: contents` element puts the holes on its children; attribute
      changes and CSS animations on a hole element re-read its parent.
- [x] opentype.js 2.0 gvar bug worked around (`text/slug/gvarFix.ts`): a
      packed point count of 0 means "all points", not "no points"; without it
      Inter's D/R (shared point list + all-points tuple) render mangled at
      any non-default weight
- [x] `text-transform`: the reader case-maps each grapheme
      (`toLocaleUpperCase`/`LowerCase` with the closest `lang`, so `tr`
      dotted İ works) before deriving `glyphId`/`text`; a grapheme that grows
      (ß -> SS) goes to the fallback atlas. `capitalize` uses an approximate
      word start (previous grapheme not a letter/number/mark; `'` and `.`
      between letters are word-internal; no context across text nodes;
      upper case for title case). Pseudo-element content is transformed too.
      `full-width` / `full-size-kana` are ignored. Playground section
      `texttransform` (parity 3.09% -> 1.25%; `duo` 1.81% -> 1.69%).
- [x] `letter-spacing`: Chrome adds the tracking on the right of each
      grapheme's rect (RTL too), and Slug/atlas placement already runs from
      the rect's left edge via the glyph bbox, so glyphs were never
      stretched. Non-zero `letter-spacing` now disables `liga`/`clig`, as
      Chrome does (the matcher had drawn fi/ffi under tracking).

## Phase 2 — fidelity
- [x] Image pass: <img> textures + object-fit (fill/cover/contain), sRGB target
- [x] Images: `<canvas>`/`<video>` sources (dynamic textures, live re-upload)
- [x] Images: background-image url() (size/position/repeat, rounded clip, async load → scoped re-read), linear/radial gradients in the box pass, mipmaps for static textures
- [x] Images: shared mipmapped texture atlas (`images/imageAtlas.ts`; static
      images ≤1024px; consecutive atlas instances draw as one call; `draws` stat)
- [x] Every background layer paints (gradients and url() layers in
      order, border on top), `repeating-linear/radial-gradient`, url()
      `background-size` lengths; elliptical radii (`radiusY`, `sd_box`) for
      boxes, images, cutouts, outlines; `::selection` highlight boxes
      (selected text keeps its colour); doubled AA on square-cornered
      round-dot corners; `cutouts: false`; windowed `fps`; URL SVGs sized
      from their fetched markup (same-origin, no fragment).
- [x] Conic and repeating-conic gradients; gradient
      `background-size`/`-position`/`-origin` tiles, per-axis repeat;
      elliptical outer and inset shadows
- [ ] Atlas eviction + edge-filled gutters
- [x] Stacking contexts + z-index (Appendix E paint order, cross-layer draw batches)
- [x] Opacity groups: opacity<1 contexts render offscreen and composite once (`scene.groups`, push/pop markers in the batch list, pooled targets)
- [ ] Isolated groups for `filter` / `mix-blend-mode` / `isolation` (same push/pop machinery)
- [x] `overflow` clipping (per-instance clip rects; rounded-corner clip is a follow-up)
- [x] `replace` mode: hide DOM paint while preserving hit-testing & a11y (+ scroll tracking)
- [x] Per-layer dirty tracking (upload only changed layers; `uploads` stat)
- [x] Sub-tree reconciliation: mutations re-read only their boundary subtree; escalates to a full read when the boundary's rect changes (persistent element tree, CPU-only re-flatten)

## Phase 3 — reach & polish
- [x] Site-mode harness (`npm run test:site -- --url …`): inject the library into
      any page, DOM-vs-GPU parity per scroll offset; bonobolabs.com home reads
      0.1–1.8% at every offset
- [x] Real-page fixes from bonobolabs.com: per-side borders (`border-bottom`
      links), inline `<svg>` icons, responsive `srcset` uploads via
      `createImageBitmap` (naturalWidth is density-corrected), SVG `<img>`
      rasterised at display size (gatsby-plugin-image sizers stalled lazy loads),
      `process.env` shim for typegpu
- [x] Border styles: dashed / dotted / double in the box shader, ported
      from Blink's `BoxBorderPainter` + `DashEffectFromStrokeStyle`. Boxes
      without radii fit the pattern per side over the full outer length
      (dash or dot flush at both corners, gap refitted; square dots ≤3px
      keep w/w and get Blink's `EnforceDotsAtEndpoints` 1px end fixes).
      Rounded boxes stroke one closed centreline path (inset floor(w/2),
      starting after the top-left arc) with the gap fitted to its whole
      length, arcs measured as Skia's chord approximation
      (`skQuarterArc`). Dashed 3w/2w under 3px, 2w/w from 3px; round dots
      >3px. Left: the doubled AA on round corner dots (both sides paint
      them in Chrome)
- [x] Background under translucent borders (`background-clip`
      border/padding/content-box; border source-over the fill, dash gaps
      show it; gradient tile repeats into the border area) and
      pixel-snapped borders (untransformed box edges snapped to device px
      in `BoxPass.upload`, widths floored with a 1 device px minimum,
      box-filter edge AA)
- [x] `background-clip` / `background-origin` and pixel snapping for
      `url()` backgrounds (image pass): the record's local box is the clip
      box, `originInset` the positioning area (tiles repeat into the border
      area), radii follow the clip box, the border paints over the image
      (border-only box after it), untransformed image/background
      destination rects snap like boxes with UVs following the snapped
      rect; only the first `background-image` layer is painted
- [ ] External `<use href>` in inline SVG
- [x] Consolidation review: lifecycle (destroy/device-lost/start-after-stop),
      leaks, `visibility`, inline transforms + `rotate/scale/translate`,
      colour parsing, decoration order, animation scoping; docs reconciled
- [x] `position: fixed` → viewport-space records (`space: 'viewport'`,
      `to_clip` in `FRAME_WGSL`); `sticky` → paint-only re-read of moved
      stickies on scroll. Not handled: `background-attachment: fixed`,
      fixed pseudo-elements, element scroll containers
- [ ] Web Animations API (`element.animate()`) fires no CSS events → untracked
- [x] Perf harness (`npm run test:perf`) + CPU profile; read-pass scroll snapshot
      and grapheme-segmentation cache (full read −30%)
- [x] `FAST_TEXT_READ`: per-node `getClientRects()` + Canvas 2D suffix-width
      split, per-chunk and per-grapheme fallbacks, `stats().textRead`
      (Range queries 84k → 15k on the 400-card page, full read −26%)
- [x] Fast text read under a transform: lines measured in the local frame
      and placed through the linear part (perGrapheme 10.8k -> 2.7k, Range
      queries 15k -> 7.8k on the 400-card page)
- [ ] Fast text read for `font-optical-sizing: none` on an opsz axis (the
      canvas `font` shorthand always uses auto)
- [x] Batch builder: grid-indexed members + per-glyph text footprints
      (400-card page: 841 → 114 draws)
- [x] `text-decoration` underline / overline / line-through (per line fragment,
      propagated to inline descendants, transform-aware; solid style only)
- [x] `text-decoration-skip-ink` (descender stroke extents from a scratch
      canvas; gap 0.06em)
- [ ] dotted/dashed/wavy/double decoration styles
- [x] Outer `box-shadow` (analytic Gaussian rounded rect, multi-layer, spread,
      masked outside the border box)
- [x] Inset `box-shadow`; `text-shadow` (hard = offset Slug instances, blurred =
      atlas-rasterised shadow glyphs; extra instances after the glyph range)
- [ ] text-shadow on pseudo text; inset shadows on replaced elements
- [ ] Culling via IntersectionObserver in the draw path
- [x] Colour/emoji fonts: Canvas-2D-rasterised fallback atlas for emoji,
      uncovered code points, multi-code-point clusters and runs with no
      registered face (text now shows before fonts load)
- [ ] Atlas paint order within a batch (Slug glyphs draw before atlas glyphs)
      and Slug-side shaping of combining sequences (currently fall back)
- [x] Visual-regression harness (`npm run test:visual`: per-section DOM vs GPU
      parity + golden regression, headless WebGPU via SwiftShader fallback)
- [x] Blend in sRGB space like the browser (found by the harness: linear
      blending made every translucent overlay too light)
- [x] `::marker` / `::before` / `::after` pseudo-elements (synthesised from
      computed pseudo styles + measured text: bullets as Chrome-sized shapes,
      numbered/custom markers, string/attr() content as inline, block or
      absolutely positioned boxes)
- [ ] Pseudo content gaps: `counter()`, quotes, `url()` images,
      `list-style-image`, multi-line pseudo text, pseudo `transform`
- [ ] Optional WebGL2 backend behind the renderer interface
- [x] 2D transforms on boxes, images and text (per-instance affine; nested
      transforms; synthetic oblique) + CSS transition/animation tracking
- [x] Individual `rotate`/`scale`/`translate` properties; transforms ignored on
      inline elements (CSS semantics)
- [ ] Perspective / 3D transforms (matrix3d is flattened); rotated overflow
      clips (AABB now)

## Non-goals (for now)
CSS filters/blend modes, print, nested independent scrollers,
`background-attachment: fixed`, native COLR/CBDT rasterisation inside Slug
(emoji go through the fallback atlas).
