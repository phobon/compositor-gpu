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
- [ ] Real shaped glyph ids (cmap + browser shaping) for ligatures/bidi
- [x] On-demand per-glyph band upload with an LRU
- [x] Match per-element font-weight/style to a registered face (family +
      nearest-weight + italic resolution; multiple static faces)
- [x] Derive faces from a variable font by instancing (avoid shipping N files)

## Phase 2 — fidelity
- [x] Image pass: <img> textures + object-fit (fill/cover/contain), sRGB target
- [x] Images: `<canvas>`/`<video>` sources (dynamic textures, live re-upload)
- [x] Images: background-image url() (size/position/repeat, rounded clip, async load → scoped re-read), linear/radial gradients in the box pass, mipmaps for static textures
- [ ] Images: shared texture atlas (one bind group for many small images); repeating/conic gradients; gradient background-size/position
- [x] Stacking contexts + z-index + opacity (Appendix E paint order, cross-layer draw batches; opacity is propagated per record — isolated offscreen groups are a follow-up)
- [ ] Opacity groups: render opacity<1 subtrees offscreen and composite once (overlap inside a group currently double-blends)
- [x] `overflow` clipping (per-instance clip rects; rounded-corner clip is a follow-up)
- [x] `replace` mode: hide DOM paint while preserving hit-testing & a11y (+ scroll tracking)
- [x] Per-layer dirty tracking (upload only changed layers; `uploads` stat)
- [x] Sub-tree reconciliation: mutations re-read only their boundary subtree; escalates to a full read when the boundary's rect changes (persistent element tree, CPU-only re-flatten)

## Phase 3 — reach & polish
- [ ] Culling via IntersectionObserver in the draw path
- [ ] Colour/emoji fonts (COLR/CBDT) fallback
- [x] Visual-regression harness (`npm run test:visual`: per-section DOM vs GPU
      parity + golden regression, headless WebGPU via SwiftShader fallback)
- [x] Blend in sRGB space like the browser (found by the harness: linear
      blending made every translucent overlay too light)
- [ ] `::marker` / `::before` / `::after` pseudo-elements (list bullets are
      currently missing from the mirror)
- [ ] Optional WebGL2 backend behind the renderer interface
- [ ] Transforms / perspective on boxes (text already supports it via Slug)

## Non-goals (for now)
Video textures, CSS filters/blend modes, print, nested independent scrollers.
