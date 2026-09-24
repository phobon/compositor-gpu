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
- [ ] Validate the Slug shader in-browser; fix winding sign + band selection
- [ ] Analytic anti-aliasing (sub-pixel coverage from the reference)
- [ ] Resolve FontFace → bytes at runtime in `prepare()`
- [ ] Real shaped glyph ids (cmap + browser shaping) for ligatures/bidi
- [ ] On-demand per-glyph band upload with an LRU

## Phase 2 — fidelity
- [ ] Image pass (textures, object-fit, background-image, shared atlas)
- [ ] Stacking contexts + z-index + opacity groups
- [ ] `overflow` clipping (scissor / per-instance clip rects)
- [ ] `replace` mode: hide DOM paint while preserving hit-testing & a11y
- [ ] Per-layer dirty tracking + sub-tree reconciliation (stop full re-reads)

## Phase 3 — reach & polish
- [ ] Culling via IntersectionObserver in the draw path
- [ ] Colour/emoji fonts (COLR/CBDT) fallback
- [ ] Visual-regression harness (GPU layer vs DOM paint diff)
- [ ] Optional WebGL2 backend behind the renderer interface
- [ ] Transforms / perspective on boxes (text already supports it via Slug)

## Non-goals (for now)
Video textures, CSS filters/blend modes, print, nested independent scrollers.
