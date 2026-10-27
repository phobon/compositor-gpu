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
- [x] Layer transforms: `graph.transform` / `fx.transform` (GSAP-tweenable
      x, y, scale, rotate, opacity, origin; DOM fallback when inert);
      renderer renders all group textures before each target's single
      pass (no main-pass split per group); shots `fx-transform*`; perf
      `animated transforms` rows (compositor CPU 460 ms → 0.6 ms per frame
      for 16 cards under SwiftShader).
- [ ] Layer transform follow-ups: ~~mipmaps for group textures at small
      scales, crisp text above scale 1~~ (done 2026-10-08 differently: the
      group texture renders at the transform's scale and snaps to the pixel
      grid, so no mips are needed; rotated layers still resample once),
      ~~rounded ancestor clips~~ (done 2026-10-09 for every record, not
      only transforms: clip shapes, see CLAUDE.md; innermost rounded or
      rotated ancestor exact, outer ones by AABB; shot `roundclip`), a
      group texture atlas (one pass for many groups).
- [x] `dissolve` preset: a Material (all kinds) that reveals the target
      by value noise mixed with a sweep, soft front and optional rim;
      materials gained `hold` (records not drawn until the pipeline has
      compiled, so a reveal can't flash). Shots `fx-dissolve`,
      `fx-dissolve-full`. Used by the `/duo` hero on load.
- [x] Selection, required for `/duo`: ~~apply `::selection { color }` to
      the selected glyphs~~ (done 2026-10-08, `colorSelected`, shot
      `selcolor-select`). Hit-testing under GPU layer transforms:
      accepted as is (Ben, 2026-10-08): text is at identity in the
      middle of the viewport, so selection is off only near the edges
      and mid-reveal. Details in `docs/HANDOFF.md` (Start here, 2).
- [ ] Spec: Deviations entries in `docs/EFFECTS.md` for layer transforms,
      `progressiveBlur`, `dissolve` and Material `hold`.
- [x] Pointer trails (`fx.trail`, 2026-10-10): a viewport-space field
      faded and deposited by a compute pass, read by passes, materials
      and layers (`trail_at`, `trail_cell`, `trail_snap`, `trail(uv)`,
      `trail_page`); `stroke()` for scripted trails;
      `playground/trail.html`. Deviations in `docs/EFFECTS.md`. No
      harness shot yet (needs a pinned stroke + `decay: 1`, as the
      playground's `?stroke&hold`).
- [x] Effect authoring API (M4, built 2026-10-08; spec `docs/EFFECTS.md`
      "Authoring", contract and recipes `src/fx/README.md`). Today a
      `/duo` reveal takes data attributes in the markup, a lookup inside
      `AppScroll` and a separate dials config. Settled with Ben
      2026-10-08:
      - Home: the library (`compositor-gpu/fx`), React-free. Pages
        assign effects with hooks (`useReveal(ref, opts)` etc.), which
        live in the site.
      - Timing: GSAP and Motion are assumed alongside the compositor
        and drive effects; the library ships documented recipes, not
        integration code. Without one an effect is manual only (set
        `progress`, or `play()` with a basic built-in tween). Modes the
        recipes cover: play once on enter, replay each entry, scrub by
        scroll, manual.
      - Composition: one layer per element, shared by all its effects;
        each effect writes its own channels, combined by the library
        (scale/opacity multiply, x/y/rotate add); nested elements get
        nested layers.
      - No DOM fallback: progressive enhancement. Without WebGPU effects
        are no-ops and the page is its plain self; `fx.transform`'s
        `fallback: 'dom'` is removed.
      - Tuning: effects describe their params (name, range, default); a
        dev-only site helper builds DialKit panels from them.
      - Runtime: `createEffects(compositor)` is memoised per compositor
        and reference-counted; `Duo/fxRuntime.js` goes away.
- [x] `progressiveBlur` preset: Gaussian whose radius grows toward
      weighted viewport (or region) edges, bands or corners; shot
      `fx-progressive`. Used by the `/duo` app sections (MDS-home
      `Duo/AppScroll.jsx`): top/bottom edge bands.
- [ ] 16-bit PNGs crash the tab under SwiftShader on upload
      (Chrome decodes them to a half-float bitmap; `copyExternalImage`
      into `rgba8unorm`). Untested on hardware. Fix candidates: detect
      via the IHDR bit depth when fetching, or redraw through a 2D canvas.

- [ ] M5 — morph (planned 2026-10-26, spec `docs/EFFECTS.md` "Morph";
      spike `playground/spike_morph.*`, record
      `docs/rd/experiments/2026-10-26-segment-morph.md`: 16 segments
      per string x 6 strings + the wave pass at +0.46-0.66 ms gpu total p95
      over the running loop, M1 Pro dpr 2):
  - [x] M5a lazy loading (built and checked 2026-10-26, Chrome on the
        M1 Pro: `?nogpu` fetches no renderer or opentype.js, `?unusedfont`
        leaves the unused face unfetched; the entry also asks for an
        adapter, so a blocklisted GPU stays inert without the chunk):
        the entry (`src/create.ts`) returns the inert compositor without
        WebGPU and otherwise loads the renderer by `import()` (entry 0.9 kB
        + 25 kB shared; renderer chunk 509 kB unminified, the only
        importer of typegpu and opentype.js); opentype.js by `import()`
        (`loadParser`, started before device init; `loadFontBuffer`
        queues until it lands, `onFace` re-reads); `fonts: 'auto'`
        prepares only faces the browser has loaded or is loading, then
        each `loadingdone` (unused `@font-face` rules are never fetched);
        record passes compile their default pipeline on first draw
        (`SkeletonTwin`; the other core pipelines already did). Not done:
        presets as chunks (bundlers tree-shake unused ones; used ones are
        small), `createRenderPipelineAsync` for core passes (Chrome
        compiles off the JS thread already, and the handoff waits for
        the first draw), `formatReport` out of the shared profiler chunk
        (21 kB)
  - [x] M5b path pass (built 2026-10-26; test:round passed on the M1
        Pro, phobon.io unaffected; checked headless under
        SwiftShader at dpr 1 and 3 against the browser's own svg paint:
        only edge anti-aliasing differs; a `d` / `fill` edit patches in
        place): an inline svg root with `data-gpu-vector` or
        `data-gpu-morph` becomes one `PathRecord` per shape
        (`dom/svg_paths.ts`: path / rect / circle / ellipse / line /
        polyline / polygon / g / a / in-document `<use>`, flattened to
        lines within 0.2 device px; solid fill and stroke, fill-rule,
        caps, joins, miter limit, opacities; anything else, or a blend
        mode, draws it rasterised as before with a warning naming the
        feature). `paths/path_pass.ts` (layer `'paths'`, on by default):
        fill by winding with anti-aliasing from the nearest edge that
        separates inside from outside (`path_cross_delta`: an outline
        crossing itself shows no seams), stroke as a union of butt boxes,
        caps and join pieces (inner join corner moved inside the turn,
        gentle joints overlapping by about a pixel: no seams at joins);
        records over 256 edges get row bands (a morphing one over 256 is
        rasterised). Shared WGSL in `paths/path_wgsl.ts` for the morph
        engine. Playground section `vector` (new goldens). Not done:
        SVG-to-SVG morph interpolation (M5d, with the engine)
  - [ ] Path pass follow-ups: re-flatten when a layer transform scales an
        svg up (flattened for its read-time scale); gradients, dashes,
        clip-path, symbol / nested svg; materials on path records
  - [x] M5c `shockwave` preset (built 2026-10-26, goldens taken and
        checked on the M1 Pro; headless SwiftShader:
        renders, then-off equals the section exactly, no console errors;
        to run on the M1 Pro with `test:fx -- --update --only
        fx-shockwave` for its golden): `shockwave(fx, opts)` returns
        `{ pass, play(at?), destroy() }`; a ring from `origin` (page
        CSS px) at `speed`, fading by `decay`, gone after `life`, with
        `bulge`, `width`, `zoom`, `split`, `fringe`, `taps`; age is
        `fx.elapsed`, pixels off the ring copy through; play() is a
        no-op under reduced motion. Shots `fx-shockwave`,
        `fx-shockwave-then-off`; click the fx page's displace section to
        play one
  - [x] M5d-1 text morph in place (built 2026-10-26, goldens taken and
        visuals checked on the M1 Pro; headless
        SwiftShader: progress 0 / 1 equal each state exactly, no console
        errors; goldens to take on the M1
        Pro with `test:fx -- --update --only fx-morph`):
        `morph(fx, el, opts)` (preset style, not `fx.morph`) returns
        `{ capture(), settled(), progress, play(ms, ease), end(),
        destroy(), layer }`. Ghosts are copies of the element's Slug
        instances (`Effects.glyphGhost`, bands pinned while held); LCS
        keeps unchanged graphemes as whole glyphs, changed ones are cut
        into segments (`fx/morph_segments.ts`), Hungarian-paired and
        interpolated point to point along an arc. At rest every glyph
        quad is built op for op as the text pass builds it (ink box plus
        a device pixel, em interpolated per vertex, `fwidth` of it, colour
        from the glyph; kind and travel recomputed in the fragment rather
        than read from interpolated extras), segments cut by their
        Voronoi cell, so the ends match the live text. Reduced motion
        cross-fades. Page `playground/morph.html`; shots `fx-morph-a`,
        `-0`, `-half`, `-1`, `-b`
  - [x] M5d-2 keyed layout morphs (built 2026-10-26; checked on the
        M1 Pro 2026-10-27: test:fx exact shots and test:unit pass,
        capture() 0.6-1.9 ms over 5 swaps (budget 12), settled() 14-28
        ms; the gpu frame budget is still to profile): `layoutMorph(fx, { root, timeout, shockwave })` returns
        `{ capture(), settled(), progress, play(ms, ease), end(),
        destroy(), keys, pass }`. Elements keyed `data-gpu-morph` in both
        states pair by key (DOM order, at most `MAX_PAIRS` = 16, none
        more than a viewport off screen). One transition pass: each
        pair's box moves old -> new with its radius, the old element cut
        from the held snapshot (text keyed out by its colour, so only the
        glyphs travel; boxes as rounded rects) cross-fading into the live
        element, which a layer transform carries along (vector, crisp);
        nested pairs relative to their parent; old spots show the new
        page; the rest cross-fades. Text-only elements move by their
        content box. Params gain vec4 arrays (`count`) for the table.
        Page `playground/layout.html`; shots `fx-layout-a`, `-0`,
        `-half`, `-1`, `-b`; `test/unit/params.test.ts`
        (`docs/rd/experiments/2026-10-26-morph-ghosts.md`)
  - [x] M5d-3 morph content inside pairs
    - [x] SVG shape morphs (built 2026-10-27; headless SwiftShader:
          progress 0 / 1 exact, no console errors; checked on the M1 Pro
          2026-10-27): a keyed svg drawn as vectors on both sides morphs in
          `layoutMorph` (pair kind 2): `Effects.pathShapes(el)` gives its
          path records as viewport polylines (`fx/path_shapes.ts`);
          shapes pair by paint order and subpaths by order, resampled
          to `MORPH_POINTS` = 64 and aligned (winding direction,
          least-travel start; open ones may reverse); a subpath on one
          side only grows from or shrinks to its centroid carried with
          the box. The pass fills (path_wgsl winding and edge distance)
          and strokes the points in between, colours and widths mixed,
          while a layer transform hides the live svg in flight; its old
          spot shows the snapshot background around it. Tables:
          `MAX_SHAPES` 16, `MAX_CONTOURS` 24 in all (past them the pair
          cross-fades as a box, with a warning). Playground icons
          (play -> pause, check -> plus, circle -> star) and a stroked
          hexagon -> triangle; `test/unit/path_shapes.test.ts`
    - [x] Text segment morphs in pairs (built 2026-10-27; headless
          SwiftShader: progress 0 / 1 exact, no console errors; checked
          on the M1 Pro 2026-10-27): a text-only pair whose string changed morphs
          through a pooled `morph` (`capture(el)`, `settled(t, el)` for a
          replaced element, `showLive`, `ready`), pair kind 3. Its layer
          draws for the pass alone: `Transition.addLayer(layer)` and
          `overlay(uv)` (a scene-sized texture drawn before the stages;
          `LayerState.offscreen`), composited whole over the pages'
          blend; the live text hidden in flight, the old keyed out of the
          snapshot. Option `text` (morph settings, or false). The
          playground's title changes ("Projects" -> "Project 01")
    - [x] Assemble and scatter (built 2026-10-27; headless SwiftShader:
          assemble at 1 and scatter at 0 equal the text exactly, no
          console errors; checked on the M1 Pro 2026-10-27): `Morph.assemble(o)` /
          `Morph.scatter(o)` after `capture()` build pieces from the
          captured text alone: every glyph cut into segments that fly in
          from (or out to) a random point within `distance` (120 px),
          turning by up to `spin` (2.5 rad), fading (flags FADE_IN /
          FADE_OUT: alpha only, outline whole); reduced motion fades in
          place. `play(ms, ease, keep)` can stay at 1 (a scatter that
          keeps the text gone). Morph page buttons; shots
          `fx-morph-assemble-half`, `-1`, `fx-morph-scatter-0`, `-half`.
          A free WGSL `pose` hook is left for the framework extraction
    - [x] Route swaps across scroll positions (built 2026-10-27;
          headless SwiftShader: progress 0 / 1 exact from 380 px down
          back to the top, no console errors; checked on the M1 Pro
          2026-10-27):
          the pass already works in viewport space (old boxes in the
          snapshot's, new ones measured at settled()); layer transforms
          and the new boxes follow any scroll after settled() (re-read
          each progress write), and a text morph's old copy moves by the
          scroll since capture() so it stays where it was on screen
          (page-space glyphs only). Page `layout.html?scroll`; shots
          `fx-layout-scroll-a`, `-0`, `-half`, `-1`, `-b`. Svg shape
          points don't follow a scroll after settled()
  - [x] M5e runtime JFA distance fields (built 2026-10-27; headless
        SwiftShader: fields build and rebuild on edits only, glow and a
        distance-band pass read them, no console errors; checked on the
        M1 Pro 2026-10-27). `fx.sdf(el, { spread = 32, resolution = 512 })` returns
        `{ el, spread, resolution, ready, builds, rebuild(), destroy() }`:
        `el` is isolated (as a region pass, its group grown by `spread`);
        on a frame where its content key changes (box, record ids, image
        uploads) the region handler seeds from the group's alpha (>= 0.5
        inside, boundary texels; the most covered of the k x k group
        texels a field texel spans, so a 1 px line survives a smaller
        field, and nothing past the group's used region), jump-floods in log2(size) steps
        (rgba16f ping-pong) and resolves the signed distance in CSS px
        (r16f, at most `resolution` texels a side), compositing the group
        unchanged; other frames composite it plainly. Passes and layers
        read it with an `sdf` option: `sdf(p)` (page CSS px; past the
        field, its edge plus the way out), `sdf_ready()`
        (`sdfWgsl(group, binding)`; group 3 on passes, bindings 15-17 on
        layers). Layers gain `place: { before: el }` (under an element;
        an anchor at its subtree's first z). Preset `glow(fx, el, { color,
        width, offset, glowColor, glow, strength, spread })`: one quad
        under the element. Page `playground/sdf.html` (heading, card,
        vector svg, image; `?off`); shots `fx-sdf`, `fx-sdf-off` (= the
        page with none, exactly). Notes: a full re-read rebuilds every
        field (record ids change); materials can't read fields yet; an
        element with a field can't also take a region pass or keep a
        layer transform
  - [x] Text drawn on the page vs in an isolated group (found 2026-10-27
        with M5e; closed 2026-10-27 as a SwiftShader artefact).
        `npx tsx test/diag/group_text.ts [--swiftshader]` moves a heading
        0-7 px and compares the page's drawing with a group's: on the M1
        Pro (headed, Apple metal-3) every offset matches (at most 1
        level); under SwiftShader the page's Slug text differs by up to
        35 levels at some absolute positions (top 72, 74, 76 px) with
        identical instances and draws. Harness comparisons between text
        on the page and in a group can fail under SwiftShader only
  - [ ] M5f `compositor-gpu bake` + manifest loader
    - [x] Fonts (built 2026-10-27; headless SwiftShader: morph.html
          baked equals parsed exactly at rest and in flight, opentype.js
          never loaded, the sdf page's unbaked weight falls back and
          still matches; test:unit 114; to check on the M1 Pro).
          `npm run bake [-- config]` (tools/bake.ts) reads
          compositor-gpu.bake.json: per font file, family, weights
          (variable instances), italic, opsz (axis values to bake) and a
          unicode range; writes a `.cgf` per (weight, opsz) and
          `manifest.json`, warning about licences. The `.cgf`
          (src/text/slug/baked.ts): metrics (f64), the cmap and default
          ligatures within the ranges, and per glyph its bbox and advance
          (f64), outline quads (f32, the GPU's precision) and Slug band
          lists (u16 indices), about 1.1 KB a glyph (a third gzipped);
          decodeBakedFont builds the same GlyphBands as parsing
          (test/unit/baked.test.ts compares every glyph). Pages pass
          `assets: url`: the manifest is fetched at start (opentype.js is
          not preloaded then); prepare() loads a baked family's files
          instead of its sources when the page first uses it; runs match
          a baked face by family, slant, weight (clamped to the wght
          range, or nearest for static fonts) and exact opsz (or the
          axis default); anything else falls back to the source (parsed
          then, once per family). `npm run bake:playground`; pages
          `morph.html?baked`, `sdf.html?baked`; shots `fx-morph-baked`,
          `-baked-half` (test:fx bakes first). Not yet: a published
          `compositor-gpu` bin, woff2 sources, codepoints outside the
          ranges per glyph (they fall back to the atlas, not the source)
    - [x] SVG files as vectors (built 2026-10-27; headless SwiftShader:
          each baked `<img>` equals its inline twin exactly, a morph
          held at 0 equals the old icon at rest; test:unit 121; to check
          on the M1 Pro). Baking inline svgs was measured first and
          dropped: on a heavy svg (20 shapes, 15k points, warm) the DOM
          walk is 0.2 ms, parsing `d` 0.6 ms and flattening 0.5 ms,
          while hashing the markup to find a baked copy costs 0.1-0.4 ms,
          and baked flattening can't follow the on-screen scale. Instead,
          `"svgs": [{ "dir", "src" } | { "file", "src" }]` in the bake
          config turns svg files into `.cgv` files (src/assets/
          vector_file.ts; tools/bake_svg.ts with a small XML reader,
          tools/xml.ts): the viewBox and preserveAspectRatio, and per
          shape its matrix, paint (presentation attributes and style=""
          cascaded statically, currentColor from `color`, <use>
          inheriting) and its outline as a path tape: the sink calls
          parsing made (src/paths/path_data.ts, now shared with
          dom/svg_paths.ts), replayed into the runtime's Flat, so it
          flattens at the on-screen scale exactly as an inline svg does.
          Files the path pass can't draw (gradients, <style> rules, %
          lengths, ...) are skipped with the reason. At runtime an
          `<img data-gpu-vector | data-gpu-morph src>` whose src the
          manifest lists draws as path records (readImgPaths, the img's
          content box, object-fit: fill only; nothing while its file
          loads, `mirrorComplete` waits), so external svgs draw sharp at
          any scale and morph (layoutMorph pairs their shapes). Page
          `vectors.html?baked`, shots `fx-vectors`, `-twins`,
          `-morph-half`, `-morph-0`, `-unbaked`. Not yet: `<style>`
          rules, an img's object-fit other than fill, css backgrounds
          of svg files
    - [ ] Effect-input textures (built 2026-10-27; headless SwiftShader:
          textures.html loads both, the ramp layer equals ramp.png over
          the page to 0.5 levels, the noise warp pass and grain material
          draw; test:unit 126; to check on the M1 Pro). `"textures": [{
          name, file, color }]` in the bake config: a PNG (at most 4096
          px a side) becomes a `.cgt` (src/assets/texture_file.ts): RGBA8
          texels with the whole mip chain built offline (2 x 2 box, odd
          edges folded in; "srgb" in linear light weighted by alpha,
          "linear" plain averages), each byte stored as its residual from
          the gradient prediction (left + above - above-left, as PNG
          does: the noise tile 66 KB raw-deflated, 34 KB filtered, all 8
          levels), deflated. Not PNG files: the browser's image decode
          would apply colour management and premultiplication, and
          writeTexture of exact bytes skips both and the mip pass
          (DecompressionStream('deflate') inflates). Stored rgba8unorm,
          colour sRGB-encoded like the page (nothing in the compositor is
          an -srgb format). `fx.texture(name)` -> Texture { name,
          loaded, ready }; passes, layers and materials take `textures:
          { name: texture }` (at most 4): `tex_<name>(uv)`, `_level`,
          `_size`, `_levels`, `_ready` (src/fx/textures.ts; group 2 from
          binding 5 for passes and materials, group 1 from 18 for
          layers; a pass's layouts are made per trail / count / group 3
          and kept). Loaded on first use; transparent until then. Page
          `textures.html`, shots `fx-textures`, `-off`, `-ramp`. Not yet:
          tiling samplers (fract in WGSL for now), KTX2 / Basis for big
          textures, textures in transitions' snapshot passes or a layer's
          `simulate`
    - [ ] Distance-field masks
  - [x] Catch exceptions from author code (2026-10-26, `guarded` in
        `util/log.ts`): layer and material `update`, every frame hook,
        `onGlyph`, `onFrame`; logged once per label and message, the
        frame carries on (a throw used to stop the frame loop)
- [ ] Framework extraction (later; not for the progressive-enhancement
      build): a free WGSL `pose(piece, t)` hook for morph pieces (M5
      Q10; assemble and scatter cover the presets); font parsing and path work in a worker; range-split baked
      fonts; KTX2 for page images; a global velocity buffer for motion
      blur; a Vite plugin for the bake CLI; glyph outline morphs between
      whole glyphs; variable-font deltas and weight morphs; automatic
      morphs on keyed mutations; simulated (compute) morphs

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
      rays per direction, coverage gamma 0.87, quad grown a device pixel
      so edge stems keep their AA fringe (text parity 0.95% -> 0.36%)
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
      site chrome (nav, footer) keeps painting itself. The split follows the
      DOM while hidden: elements added later are hidden, and ignored elements
      added or marked after the handoff get their ancestors split (a
      MutationObserver on childList + `data-gpu-ignore`). `stats().frameMs` /
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
- [x] Image atlas eviction (2026-10-13): entries used in neither of the
      last two uploads are dropped when a new one doesn't fit at 4096px,
      the rest repacked tallest first by texture copy (also recovers the
      space shelves packed before a grow waste); growth copies the old
      texture instead of re-uploading from sources; standalone textures
      not drawn for 10 s are destroyed. `npm run test:atlas`
- [ ] Atlas edge-filled gutters
- [x] Stacking contexts + z-index (Appendix E paint order, cross-layer draw batches)
- [x] Opacity groups: opacity<1 contexts render offscreen and composite once (`scene.groups`, push/pop markers in the batch list, pooled targets)
- [x] Isolated groups for `filter` / `isolation` (2026-10-11): colour
      functions as matrices applied in order by the group composite,
      `blur()` as two Gaussian passes over the group texture, `isolation`
      a group when something inside blends. `test:visual` section
      `filters` (parity ~0.6%).
- [x] Scene reuse (2026-10-11): post passes over an unchanged scene run on
      last frame's scene texture (`reuseKey()` in `gpu/effect_snapshot.ts`,
      `stats().sceneReused`, `sceneReuse: false` to compare);
      material pipelines shared by source and `material.warm()`
- [x] `filter: drop-shadow()` (2026-10-13): an offset, tinted, blurred
      copy of the group's alpha drawn under it (two `GroupBlur` passes);
      shadows apply after `blur()` and before the colour functions;
      visual section `drop-shadow`
- [x] `backdrop-filter` (2026-10-13): blur and colour functions of what
      the element's target holds under its border box, drawn in its
      rounded, transformed shape; the target's pass splits there
      (`Renderer.drawBackdrop`, `gpu/backdrop.ts`); visual section
      `backdrop`. Deviations: the element's own opacity doesn't fade its
      backdrop; a layer transform (GPU-only) acts as a backdrop root;
      `drop-shadow()` in a backdrop-filter is ignored
- [ ] `url()` filters
- [x] `mix-blend-mode` on an element with a subtree as one blended group
      (2026-10-15): when the element's records overlap (a box or image over
      any other record), its context is a group composited with the mode
      (`OpacityGroup.blend`, per-mode composite pipelines); otherwise the
      records still blend one by one. Fallback-atlas glyphs now take the
      blend state too. Shot `blendgroup`: parity 7.71% -> 0.73%. The choice
      is made on a read of the element itself: a partial read below it
      keeps the last one
- [ ] `multiply` over a transparent backdrop (inside an isolated group)
      needs the full `cs(1-αb) + cb(1-αs) + cs·cb`, which one blend state
      can't express; `difference` stays exclusion
- [x] `mix-blend-mode` per record (2026-10-10, `scene/blend.ts`,
      `gpu/blend.ts`): `multiply`, `screen`, `plus-lighter`, `exclusion`
      exact, `difference` as exclusion (exact for black/white sources);
      built-in materials whose pipeline variant carries the blend state,
      tagged by the reader (elements' subtrees and pseudo-elements). Each
      record blends on its own rather than as an isolated group; visual
      shot `blend`
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
- [x] Web Animations API (`element.animate()`) fires no CSS events:
      `element.animate()` / `Animation.play()` wrapped (2026-10-11,
      `hookScriptAnimations`); a paused animation scrubbed through
      `currentTime` is still untracked
- [x] Perf harness (`npm run test:perf`) + CPU profile; read-pass scroll snapshot
      and grapheme-segmentation cache (full read −30%)
- [x] Frame profiler (`compositor.profile`): per-frame CPU breakdown, read
      kind and cause, GPU pass timings (`timestamp-query`), hitch blame,
      long animation frames, live HUD; `npm run test:profile` scenarios
      and `--url` page scrolls with baselines
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
      propagated to inline descendants, transform-aware); line positions and
      thickness follow Blink's `TextDecorationOffset` (2026-10-15)
- [x] `text-decoration-skip-ink` (descender stroke extents from a scratch
      canvas; gap 0.06em)
- [x] dotted/dashed/wavy/double decoration styles (2026-10-15, after
      Blink's `DecorationLinePainter`): double is a second box t + 1 away;
      dashed/dotted/wavy are boxes with `BoxRecord.line`, drawn by the box
      shader (`line_cov`: `dash_cov` from the fragment's truncated start,
      MakeWave's cubics by Newton steps). `decorstyles` section: parity
      0.54%. Not matched: skip-ink cut placement (same heuristic as solid)
- [x] Outer `box-shadow` (analytic Gaussian rounded rect, multi-layer, spread,
      masked outside the border box)
- [x] Inset `box-shadow`; `text-shadow` (hard = offset Slug instances, blurred =
      atlas-rasterised shadow glyphs; extra instances after the glyph range)
- [x] text-shadow on pseudo text; inset shadows on replaced elements
      (2026-10-15): the `<img>`/`<canvas>`/`<video>`/inline `<svg>`
      content paints over the element's inset shadows, and replaced
      content is drawn in the content box with the inner radii (it filled
      the border box, over borders and padding). Shot `shadowgaps`:
      9.51% -> 1.97%; `images` parity 3.23% -> 1.99%
- [x] Image atlas entries start on 16px multiples (2026-10-15): an
      unaligned entry's mip levels 1-4 straddled its pixel grid, so how
      blurred a downscaled image looked depended on what had been packed
      before it (adding images in one section changed `filters` parity
      0.59 -> 0.94). Parity improved in `gradients`, `bglayers`, `png16`,
      `roundclip`, `canvas`; goldens with images need `--update`
- [x] Draw culling (2026-10-14): each draw batch split into the instance
      runs whose records reach the canvas region (grown by half a canvas,
      cached until the canvas leaves it; `gpu/cull.ts`,
      `CompositorOptions.cullDraws`, `stats().instances`). perf.html:
      instances per frame 75.9k -> 11.4k, draws 123 -> 33; frame time
      -12% in SwiftShader, unchanged on an M1 Pro (GPU p50 5.7 ms either
      way: fill-bound, not vertex-bound). See
      `docs/rd/experiments/2026-10-14-draw-culling.md`
- [x] Fill cost of the 3-viewport canvas measured (2026-10-14):
      `canvasFill: 'band'` (viewport plus a scroll-sized band) cuts the
      main pass 60% in SwiftShader but 26% on an M1 Pro at dpr 1, and a
      stalled main thread then reveals blank canvas (`test/fill/run.ts`).
      Default stays 'full'. See
      `docs/rd/experiments/2026-10-14-fill-cost.md`
- [x] Band at dpr 2 and culling to the band measured (2026-10-14): at dpr 2
      the full canvas misses 120 Hz on an M1 Pro (14.1 ms main pass), the
      band cuts it 53-58%; culling to the band adds little and its
      recompute spikes CPU up to 6.8 ms. See
      `docs/rd/experiments/2026-10-14-band-culling.md`
- [x] Cull recompute (2026-10-14): bounds in typed arrays (p99 2-3x lower
      on an M1 Pro); the remaining 1.5-6 ms spike is the recompute's first,
      unoptimised call (`stats().cullMs`); a y index cut it in band mode
      on the M1 Pro (1.0 ms max) but not in full mode (2.9 ms). See `docs/rd/experiments/2026-10-14-cull-recompute.md`,
      `-cull-spike.md`, `-cull-index.md`
- [x] Edit cost (2026-10-14): partial reads that keep the scene's structure
      patch it in place; on an M1 Pro a class toggle 32 -> 2.3 ms, a word
      swap 31 -> 11.8 ms. See `docs/rd/experiments/2026-10-14-edit-cost.md`
      and `2026-10-14-edit-patch.md`
- [x] Moved-glyph edits (2026-10-16, `refitBatches`): the batch list is
      kept when the moved records' new footprints break no paint order,
      cull bounds updated in place; word swap 15.6 -> 1.9 ms on an M1 Pro.
      See `docs/rd/experiments/2026-10-16-moved-glyph-edits.md`
- [ ] Patched edits upload only the replaced box/image ranges (~1 ms of
      whole-buffer writes left per edit)
- [x] Kept margins for the band (2026-10-14): `canvasFill: 'band'` keeps
      them (`'band-clear'` for the A/B); at dpr 2 on an M1 Pro, 45-50% of a
      full redraw with no dropped frames. See
      `docs/rd/experiments/2026-10-14-band-margins.md`
- [x] `'band'` is the default (2026-10-14): kept margins also under a post
      chain; `canvasPin: 'viewport'` stays 'full'; stall checks match
      'full' on an M1 Pro and in SwiftShader (fixed header, upward stall,
      blur pass). See `docs/rd/experiments/2026-10-14-band-default.md`
- [x] Fullscreen blur at dpr 2 (2026-10-15): `downsample` pass option,
      `blur` at half resolution from 8 device px of radius; frame 12.0 ->
      7.5 ms on an M1 Pro, no dropped frames at 120 Hz. See
      `docs/rd/experiments/2026-10-15-blur-downsample.md`
- [x] Re-anchor tail (2026-10-16, `reanchorStrips`): a re-anchor's new rows
      drawn a strip per frame (twice the scroll step, at least 96 CSS px,
      culled to its rows); `scroll-long` GPU p99 at dpr 2 on the M1 Pro
      11.56 -> 8.09 ms, p50 unchanged, p95 +3.4%
      (`docs/rd/experiments/2026-10-16-reanchor-tail.md`). Open: the p99
      margin is under the run-to-run spread; a SwiftShader-only 5 px
      difference where a group crosses a strip edge
- [x] GPU headroom at dpr 2 measured (2026-10-16): a band scroll frame's
      ~7 ms `gpu total` is real occupancy (frames drop with ~1.7 ms more);
      per-pass `alone` times are not a cost on Metal. See
      `docs/rd/experiments/2026-10-16-gpu-headroom.md`
- [x] Scroll frames draw only changed rows (2026-10-16, `skipUnchanged`):
      50-62% of scroll frames on perf.html skipped, drawn frames ~2 ms GPU
      at dpr 2 instead of 7.5 ms. See
      `docs/rd/experiments/2026-10-16-skip-unchanged.md`
- [x] Fixed content as damage (2026-10-17): its old and new rows redrawn
      on scroll instead of the band; ~3 ms GPU at dpr 2 with a fixed bar
      (was ~6.9). See `docs/rd/experiments/2026-10-17-fixed-damage.md`
- [x] Partial redraws culled to their own rows (2026-10-17): `scroll
      --fixed` p99 4.10 -> 3.32 ms, `scroll-long --fixed` 8.33 -> 7.95 ms
      (`docs/rd/experiments/2026-10-17-row-culling.md`)
- [ ] Re-anchor frames with fixed content still ~8 ms at p99 (fill and
      copies, not draw count): time their parts with a profiler mark,
      then shrink or defer the first strip on those frames
- [x] Layer transforms and region passes as damage, static materials
      no longer a change (2026-10-17): one animated card 6.1 -> 4.2 ms GPU
      at dpr 2 (`docs/rd/experiments/2026-10-17-layer-damage.md`)
- [ ] A transformed group's texture is re-rendered every frame even when
      only its affine changed
- [ ] `/fx` extra layers (`fx.layer`), changing materials and sticky
      elements (re-read every frame while they move) still redraw the
      band every frame
- [ ] Drawn scroll frames: cull the thin newly needed rows' draws to
      those rows; the full kept-to-canvas copy remains
- [x] Opacity-group pass cost measured (2026-10-14): the reported 2.6-3.2 ms
      was mostly overlap with the main pass (the profiler now prints
      `alone` per pass label); real cost 0.90 ms per frame on an M1 Pro for
      ~5 groups, mostly per pass. See
      `docs/rd/experiments/2026-10-14-group-pass-cost.md`
- [x] Group atlas (2026-10-15): a parent's leaf groups share one texture
      and pass (`groupAtlas`, default on); 5 groups 5 passes -> 1, cost
      0.18 -> 0.04 ms at dpr 1 on an M1 Pro. See
      `docs/rd/experiments/2026-10-15-group-atlas.md`
- [x] Many-groups scenarios (2026-10-15, `test:profile` `groups` /
      `fade`, `--groups N`): 48 held groups cost 0.70 ms per frame with
      the atlas, 2.10 ms without, on an M1 Pro at dpr 2. A style-driven
      fade runs at ~26 fps whatever the count: every opacity change
      rebuilds the scene and re-packs all text (~33 ms CPU). See
      `docs/rd/experiments/2026-10-15-many-groups.md`
- [x] Opacity-only edits without a rebuild (2026-10-16,
      `patchOpacity`): contexts matched between reads, groups' alpha set
      in place, faded elements held as groups at opacity 1 for 1 s. Fade
      of 48 elements on an M1 Pro: 36.4 -> 4.3 ms CPU, GPU 11.1 -> 6.8 ms.
      See `docs/rd/experiments/2026-10-15-opacity-patch.md`
- [ ] Opacity edit floor (4.3 ms): skip re-reading a subtree whose only
      change is its root's opacity; upload only replaced box/image
      ranges; measure the hold-release frame
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
- [x] Pseudo content (2026-10-15): `counter()` / `counters()` and quote
      keywords from one walk of the document per read, run only when some
      pseudo's content needs it (`dom/generated.ts`: reset / increment /
      set scopes, implicit `list-item`, quote depth; reads every element's
      and its pseudos' computed style, so a page with `<q>` or counters pays
      for it on each read); `url()` content at natural size, bottom on the
      baseline; background `url()` layers on pseudo boxes;
      `list-style-image` markers (Chrome's 7px padding). Shot `gencontent`:
      parity 0.97%
- [ ] Multi-line pseudo text, `disclosure-*` markers (pseudo `transform` /
      `translate` / `rotate` / `scale`: done 2026-10-10, `boxAffine` in
      `dom/transform.ts`; a pseudo scaled to nothing paints nothing)
- [x] Replace-mode handoff (2026-10-11): the source stays painted until
      the mirror is complete (fonts, image uploads, pipelines; capped by
      `handoffTimeout`), then is hidden in the same task as a render;
      `compositor.ready`. Fixes the flash of a half-built mirror on load
- [x] Font discovery reads `@font-face` inside `@layer`, `@import`ed
      sheets and matching `@media` / `@supports` (2026-10-10; phobon.io's
      faces live in an `@layer`)
- [ ] Optional WebGL2 backend behind the renderer interface
- [x] 2D transforms on boxes, images and text (per-instance affine; nested
      transforms; synthetic oblique) + CSS transition/animation tracking
- [x] Individual `rotate`/`scale`/`translate` properties; transforms ignored on
      inline elements (CSS semantics)
- [ ] Perspective / 3D transforms (matrix3d is flattened); rotated overflow
      clips (AABB now)
- [ ] Transition effects (plan of 2026-10-18, from a reference video):
  - [x] P1 presets `rgbSplit`, `glitchSlices`, `vignette` (with `flash`);
        shots `fx-rgbsplit`, `fx-rgbsplit-pointer`, `fx-glitch`,
        `fx-vignette`, `fx-p1-then-off` (2026-10-18; then-off 0 px)
  - [x] P3 transitions between two DOM states through a held snapshot
        (`fx.transition`: `capture()` / `settled()` / `end()`,
        `prev(uv)`; `playground/transition.html`, shots
        `fx-transition-*`, `test/transition/run.ts`). 2026-10-18, M1 Pro
        headed, dpr 2, 20 swaps: 0 frames showed the source DOM;
        capture() p95 10.3 ms; settled() p50 16 / p95 22.6 ms (max 350
        ms, the first swap); progress frames 0 late or dropped, interval
        p95 9.2 ms, `gpu total` p95 0.43 ms (the scene is reused while
        only progress changes). Ends equal both pages exactly
  - [x] P2 `lens` (fisheye with an RGB fringe at its edge, shot
        `fx-lens`) and `radialReveal` (a transition from the pointer
        with a bent, fringed edge; `playground/transition.html` uses it,
        `?lens` adds a lens). 2026-10-18: transition frames `gpu total`
        p95 1.16 ms at dpr 2 (0.43 with a plain circle), 0 dropped
  - [x] P4 element intro: `reveal` (one region pass: blur, red/blue
        split, slices, wash and fade by one `progress`) and `develop`
        (an image material: fade in from washed and grey); shots
        `fx-reveal`, `fx-reveal-0`, `fx-reveal-then-off` (2026-10-18)
  - [ ] P5 3D image gallery: `gallery` (a Layer of image planes on a
        ring, projected on the CPU, sorted back to front, perspective-
        correct texturing, anti-aliased rounded edges) over a new layer
        binding, `images` (`fx/imageArray.ts`: several image records in
        one mipmapped texture array); `playground/gallery.html` opens
        and closes it through radialReveal and a white flash; shots
        `fx-gallery-pre` / `fx-gallery` / `fx-gallery-off` (built
        2026-10-18, not yet run)

## Non-goals (for now)
CSS filters, the other blend modes, print, nested independent scrollers,
`background-attachment: fixed`, native COLR/CBDT rasterisation inside Slug
(emoji go through the fallback atlas).
