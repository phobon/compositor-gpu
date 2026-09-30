# Roadmap

## Where to pick up (2026-09-29)

**State.** Phases 0–2 complete, Phase 3 largely done, and the library is
mounted on the real site: mds-home's `/duo?gpu=1` runs it from the
`compositor-gpu` submodule (`&stats=1` corner readout, `&debug=1` library
logging, `&mode=replace` hides the DOM's own paint). Site chrome (nav,
footer, scroll-top, the portalled nav popup) is excluded with
`data-gpu-ignore`. Every harness passes on the current tree:

- `npm run test:visual` — 20 playground sections, DOM-vs-GPU parity
  0.15–2.2% (images 5% from resampling); text sections ~2% now that glyph
  placement matches Blink and the capture is grayscale-AA. Goldens are
  local + GPU-specific: run `-- --update` once after `npx playwright install
  chromium` on a new machine.
- `npm run test:perf` — 400-card page: full read ~370–550 ms (sandbox noise
  ±30%), partial read ~20–40 ms, encode <1 ms, 114 draws.
- `npm run test:site -- --url http://localhost:8000/duo` (gatsby develop
  running) — 0.3–1.0% at three offsets, clean console.

**Chrome on `/duo`** is in good shape: read 0.7 ms idle, no fallback glyphs
once every element is Inter, nothing invalidating the mirror at idle.

**Next, in order.**
1. **Safari — closed.** The "scroll lock" and the 8 s stall on load were
   both gatsby develop's runtime-error overlay: a Safari extension's
   injected script does `parsed['@context'].toLowerCase()` on every
   `application/ld+json` block and threw on mds-home's array-form schema.
   Fixed in mds-home (`SEO.jsx` emits one `@graph` object); dev-only,
   never affected production. Safari now scrolls and loads cleanly with
   the compositor on. Left as a perf item: Safari's full read is ~65×
   Chrome's (`Range.getBoundingClientRect` per grapheme, `frame 49 ms`
   steady state vs 0.7 ms) — if it is the floor, batch reads per text node
   with `getClientRects()`.
2. **Scroll-frame lag (overlay mode)** — done. The loop stays on rAF for
   `SCROLL_SETTLE_MS` after each `scroll` event, and the canvas scrolls with
   the document: `position: absolute`, the viewport plus `canvasMargin`
   (default one viewport height) above and below, re-anchored in the frame
   only when the viewport leaves it (`stats().anchorX/anchorY/reanchors`),
   so the compositor thread moves it in lockstep with the DOM. Fixed
   (viewport-space) content still moves with the page between frames. Cost:
   the canvas is up to 3× the viewport area; check fill rate on a real
   device (SwiftShader `steady fps` dropped ~5.5 → ~2 on `test:perf`).
3. **`mode: 'replace'` on the real page** — exercised by the harness, not
   yet used interactively; check hover/focus/selection still work and that
   the excluded chrome stays painted.
4. **Remaining `/duo` gaps.** Border fill/snapping and `text-transform` /
   `letter-spacing` are done (Phase 1/3). Open: dash phase on dashed/dotted
   borders around corners (the placeholder border still drifts out of
   phase), `background-clip` / snapping for `url()` backgrounds (image
   pass), `capitalize` context across text nodes and title-case mappings,
   `full-width` / `full-size-kana`, Greek final sigma under `lowercase`.
5. **Housekeeping.** Commit + push compositor-gpu, bump the submodule
   pointer in mds-home (`git -C compositor-gpu pull`), `git submodule`
   the local checkout back onto a clean HEAD; delete `_staging/` here and
   `_to_delete/` in mds-home; upstream the opentype.js gvar fix
   (`text/slug/gvarFix.ts`) as an issue/PR so the workaround can go.

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
- [x] Analytic anti-aliasing (signed sub-pixel coverage + 3-tap vertical AA)
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
      overlays and anything else that mutates every frame.
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
- [ ] Atlas eviction + edge-filled gutters; repeating/conic gradients; gradient
      background-size/position
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
- [x] Border styles: dashed / dotted / double in the box shader (arc-length
      along the rounded outer edge, pattern period fitted to the perimeter
      like Chrome; round dots ≥3px)
- [x] Background under translucent borders (`background-clip`
      border/padding/content-box; border source-over the fill, dash gaps
      show it; gradient tile repeats into the border area) and
      pixel-snapped borders (untransformed box edges snapped to device px
      in `BoxPass.upload`, widths floored with a 1 device px minimum,
      box-filter edge AA)
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
