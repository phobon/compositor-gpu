# Roadmap

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
- [x] Consolidation review: lifecycle (destroy/device-lost/start-after-stop),
      leaks, `visibility`, inline transforms + `rotate/scale/translate`,
      colour parsing, decoration order, animation scoping; docs reconciled
- [ ] `position: fixed` / `sticky` scroll with the document (needs a
      viewport-space record kind or a scroll-triggered re-read of those subtrees)
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
- [ ] Perspective / 3D transforms (matrix3d is flattened); individual
      `rotate`/`scale`/`translate` properties; rotated overflow clips (AABB now)

## Non-goals (for now)
Video textures, CSS filters/blend modes, print, nested independent scrollers.
