# Roadmap

## Where to pick up (2026-09-25)

**State.** Phases 0–2 are complete; Phase 3 is largely done. Every feature is
gated by the harnesses, which all pass on the current tree:

- `npm run test:visual` — 19 playground sections, DOM-vs-GPU parity 0.3–4.9%
  (text sections sit at 4–5% from glyph AA; everything else ≤3%). Goldens are
  local + GPU-specific: run `-- --update` once after `npx playwright install
  chromium` on a new machine.
- `npm run test:perf` — 400-card page: full read ~370–550 ms (sandbox noise ±30%),
  partial read ~20–40 ms, encode <1 ms, 114 draws.
- `npm run test:site -- --url <url>` — parity on any real page. The
  bonobolabs.com home page (static `public/` build) reads 0.1–1.8% at ten scroll
  offsets with a clean console.

**Real-site next steps (mds-home).**
1. The site uses only system fonts, so every glyph currently goes through the
   Canvas 2D fallback atlas (`stats().faces === 0`). Slug — and therefore
   `onGlyph` letter animation — needs a web font shipped as TTF/OTF/WOFF
   (opentype.js can't read WOFF2). Pick one for `/duo` and register it with
   `@font-face`; `fonts: 'auto'` (the default) will find it.
2. Wire `src/components/Duo/GpuCompositor.jsx`: add the submodule/alias per
   `docs/INTEGRATION.md`, `yarn add typegpu opentype.js`. `compositor-gpu`
   must be imported before anything else that imports `typegpu` (it installs
   the `process.env` shim typegpu needs in the browser).
3. Run `npm run test:site -- --url http://localhost:8000/duo --scroll 0,600,…`
   from the compositor repo while `gatsby develop` runs, read the diff PNGs in
   `test/site/out/`, and fix what's visible. Known site-specific gaps are
   listed under Phase 3 (border styles, 1px border snapping).
4. `mode: 'replace'` on the real page hasn't been exercised yet (the harness
   uses overlay + `setSourceHidden`); try `--replace`.

**Toolchain.** Deps were bumped (opentype.js 2, typegpu 0.12, TS 7 via the
TS6 shim, vite 8, biome 2.5, playwright 1.63); tsconfig/biome/vite configs are
migrated. `pnpm install` on macOS leaves no linux binaries, so checks can't run
in a Linux VM against that `node_modules`.

**Open items by value** (details in the phase lists below): Web Animations API
tracking · border styles + pixel-snapped 1px borders · `calt` alternates ·
atlas eviction · isolated groups for `filter`/`mix-blend-mode` · pseudo
`counter()`/`url()` · perspective transforms · culling · WebGL2 backend.


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
- [ ] Border styles (dashed/dotted/double), background under translucent
      borders, pixel-snapped 1px borders; external `<use href>` in inline SVG
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
