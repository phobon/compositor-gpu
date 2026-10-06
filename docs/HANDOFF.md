# Handoff — compositor-gpu + bonobolabs.com `/duo`

Rewritten 2026-10-03, updated 2026-10-05 (M2, M3a), to resume in a fresh
session. `ROADMAP.md` is the live checklist (mirror phases + effects
milestones), `docs/ARCHITECTURE.md` the
mirror's spec, `docs/EFFECTS.md` the effects layer's. This file is the
context around them: checkouts, how to run and verify things, and the first
move on each open item.

## Where things are

| Path | What | Position |
| --- | --- | --- |
| `~/code/compositor-gpu` | the library, source of truth | `01c2a53 Stacked effects` (M3c, open item 3) + the uncommitted mirror batch (open item 7) |
| `~/code/bonobo/MDS-home` | the Gatsby site, branch `feature/duo_landing` | `0b9e327b Bump submodule` (pointer → `1094210 Cutouts`), 1 ahead of origin, + uncommitted `src/components/Duo/GpuCompositor.jsx` (`zIndex` prop, default 500), `GpuStats.jsx` (readout line) and `src/components/primitives/SharedLayout.jsx` (footer above the canvas, item 2) |
| `~/code/bonobo/MDS-home/compositor-gpu` | git submodule | checked out at `5c90a6b` (≠ the committed pointer, uncommitted) |

The site runs from the submodule (`compositor-gpu` → `compositor-gpu/src`
alias in `gatsby-config.js` / `jsconfig.json`). Flow: edit + commit + push in
`~/code/compositor-gpu`, then in MDS-home `git -C compositor-gpu fetch origin
&& git -C compositor-gpu checkout origin/main && git add compositor-gpu &&
git commit`. Claude (Cowork) edits only the standalone checkout; never the
submodule.

Git runs from the Cowork VM leave lock files it cannot delete: remove any
that exist before git work. Now: `compositor-gpu/.git/index.lock`,
`MDS-home/.git/index.lock`, `MDS-home/.git/modules/MDS-web-ui/index.lock`.
From the VM, read state with `git --no-optional-locks status` (plain
`git status` refreshes the index and leaves a lock). `_staging/` in compositor-gpu
is scratch: it holds the old `compositor-gpu-changes.diff` (tracked, see
above) and `tree-16df20b.tgz` (the archive used for verification, untracked);
delete both.

## Last batch (`ab273c8`..`16df20b`, pushed)

Verified 2026-10-03 on a clean `git archive 16df20b` in the Linux sandbox
(SwiftShader), fresh goldens: typecheck, biome, `npm run build` (both
entries) pass; `test:visual` OK, 23 shots, parity 0.08–1.13 % except
`images` 4.75 % (see open item 4: `svg, contain`), `duo` 0.23 / `duo-s900`
0.11; second run 0.00 regression everywhere; `test:visual -- --with-fx` 0.00
everywhere; `test:fx` 0.00 on every shot, `fx-blur-then-off` ≡ pre (0 px).
Not re-run (need the gatsby dev server on the Mac, or ~45 min): `test:site`
(last 1.10 / 1.24 / 1.05 %) and `test:perf` (last: full read ~425 ms, 123
draws, encode 0.30 ms idle / 0.40 ms with blur). Goldens are local and
GPU-specific: on a new machine run `npm run test:visual -- --update` and
`npm run test:fx -- --update` once.

Swept into the commits by accident: `_staging/compositor-gpu-changes.diff`
(tracked since `526fdd2`; `_staging/` was meant to stay untracked scratch)
and a `yarn.lock` (`ab273c8`) next to `pnpm-lock.yaml`. Decide whether to
`git rm` both and add `_staging/` to `.gitignore`.

Mirror:

- **Cutouts.** `data-gpu-ignore` elements punch holes in the mirror
  (`CutoutRecord`, `boxes/cutoutPass.ts`, destination-out at the element's
  paint-order z) so the page's own paint of them shows through; an ignored
  `display: contents` wrapper (how `SharedLayout`'s `GpuIgnore` works) puts
  the holes on its children; attribute changes / CSS animations on a hole
  element re-read its parent. Replace mode no longer blanks a page with
  ignored chrome (`HIDDEN_ATTR` carries the pre-hide opacity). Fixed chrome
  should sit ABOVE the canvas instead (its hole would trail it by a frame
  while scrolling): `CompositorOptions.zIndex`, mds-home passes 500
  (content ≤ 40, ScrollTop 999, TopNav/popup 9999).
- **Dashed/dotted borders** fitted like Blink (`SelectBestDashGap`, per side
  on square corners, along the inset centre path on rounded ones, Skia's
  chord-measured arc lengths); the `/duo` placeholder border is
  pixel-identical.
- **`url()` backgrounds** honour `background-clip`/`-origin`, tile under the
  border, snap to device pixels (`ImageRecord.originInset`, shared `boxInset`,
  border split into a border-only box when an image reaches under it).
- **`FAST_TEXT_READ`** (`dom/textRuns.ts`): one `getClientRects()` per text
  node with canvas-measured splits verified within 0.05 px, per-chunk /
  per-grapheme fallbacks. Range queries 84k → 15k on perf.html, full read
  ~26 % faster, Safari `read` 55 → 2 ms. `stats().textRead` counts fallbacks.
- `docs/UPSTREAM-gvar.md`: ready-to-post opentype.js issue (check the two
  flagged items first: upstream `src/` paths, run the repro once).

Effects layer:

- `docs/EFFECTS.md` — spec settled with Ben 2026-10-01 (three primitives
  Pass / Material / Layer over a Params model, element-keyed Targets,
  runtime pointer, `/fx` entry point, three milestones). Has a Deviations
  section for what M1 changed.
- **M1 built**: `src/fx/` → `compositor-gpu/fx` (`dist/fx.js`,
  `exports['./fx']`): `createEffects(compositor)` (inert without a GPU),
  `Params` (schema → Proxy → std140 block, wake on write), pointer (raw,
  eased follower, down, click ring buffer), fullscreen `fx.pass` taking WGSL
  strings or WGSL-bodied `tgpu.fn`, presets `blur` / `displace`,
  `playground/fx.html` (+ `__fx`, control panel), `npm run test:fx`,
  `test:visual -- --with-fx`, perf `steady encode (blur)`. Core touched only
  through `compositor.graph` (`gpu/graph.ts`: `PostChain`, `FrameHook`,
  `shared`, `requestFrame`). Author contract: `src/fx/README.md`.

## Running it

```bash
# site
cd ~/code/bonobo/MDS-home && yarn dev        # http://localhost:8000
open 'http://localhost:8000/duo?gpu=1&stats=1'          # overlay + readout
open 'http://localhost:8000/duo?gpu=1&stats=1&debug=1'  # + library console log
open 'http://localhost:8000/duo?gpu=1&mode=replace'     # DOM paint hidden

# library, from ~/code/compositor-gpu
npm run typecheck && npm run lint && npm run build
npm run test:visual                      # 23 shots; -- --with-fx for the invariant
npm run test:fx                          # effects goldens
npm run test:site -- --url http://localhost:8000/duo --scroll 0,600,1200
npm run test:perf                        # slow under SwiftShader (~45 min); quick on hardware
npm run dev                              # playground: /, /fx.html, /perf.html
```

`window.__gpu` is the compositor; `__gpu.stats()` feeds the readout
(`fps`/`raf`, `frame`, `worst gap`, read/upload/encode, `dirty:` counters,
`cutouts`, `textRead`, `anchorY`/`reanchors`, `scrolling`). Reference,
Chrome on the M1 Pro: read 0.6 ms idle, frame 0.3 ms, fallback 0,
`cutouts` = number of ignored chrome boxes. Safari: read 2 ms, frame 1 ms.
`fps 60 (raf 120)` while the Arc window is focused is Arc/Chromium's
presentation on that display (CVDisplayLink errors in `chrome://gpu`), not
the compositor.

## Open items, first move for each

1. **Commit.** compositor-gpu: M2 `dcf94b1`, M3a `08433a2`, mirror batch
   `5c90a6b`, `realContext` / partial-read fix `a36d65b`, M3b `7a9f504`;
   leftovers `718df5d`, M3c `01c2a53`; the mirror batch (item 7) is uncommitted. M3b added the dev dependency
   `unplugin-typegpu@0.12.3` (`package.json`, `pnpm-lock.yaml`): run
   `pnpm install` before `npm run dev` or the harnesses, since
   `vite.config.ts` imports it. MDS-home: bump the submodule to `origin/main` once
   that's pushed (`git -C compositor-gpu fetch origin && git -C
   compositor-gpu checkout origin/main`), then commit it with
   `GpuCompositor.jsx` (`zIndex`) and `GpuStats.jsx` (readout line
   `cutouts / anchorY / reanchors`; the readout never showed them). Ben
   checked `/duo` on 2026-10-05: solid apart from item 2.
2. **`/duo` findings (Ben, 2026-10-05).**
   - "The Bonobo Bundle →" / scroll-top drawn twice while scrolling (Arc,
     Safari; Ben's screenshot 2026-10-05). Cause: through a cutout the
     page's own paint under the canvas shows, and Arc/Safari leave a
     stale copy of the fixed button in that layer while scrolling. The
     copy is visible only through holes; after `5c90a6b` (no hole for
     ignored elements above the canvas) the footer's was the last one.
     Reproduced in the Claude browser pane: copy only inside the footer
     hole, gone with the canvas hidden; the mirror never contains the
     button. Fix (MDS-home `SharedLayout.jsx`, uncommitted): in GPU mode
     the footer is wrapped in `position: relative; z-index: 501`, so it
     paints above the canvas and gets no hole. Verified in the pane:
     `/duo` cutouts down to the stats panel, no copy in three scroll
     runs. Library side (uncommitted, needs the submodule bump):
     `paintsAboveCanvas` now uses `ElNode.realContext`
     (`createsRealStackingContext`: relative/absolute + `z-index: auto`
     is not a context), so the stats panel's hole goes too; and
     `partialRead` seeds `inIgnored` from the boundary's parent, so a
     re-read child of an ignored `display: contents` wrapper stays a
     hole. Gates on the cloud tree: typecheck, biome, `test:visual` 0.00
     on all 25, `--with-fx` 0.00, `test:fx` all 26 OK.
   - Replace mode focus rings: fixed 2026-10-05 (item 5): `outline` is
     mirrored and focus changes re-read.
   - Drag-select doesn't show in replace mode (`::selection` not
     mirrored). Ben: expected; no decision yet on mirroring it.
3. **Effects.** M2 (Target, Layer, region Pass, `cursorGlow`,
   `clickRipple`, `displace` `mode`) is committed (`dcf94b1`; push mode
   left as is). **M3a, materials** is committed (`08433a2`):
   `fx.material({ target, kinds, vertex, fragment, subdivisions,
   hideSource })`, the `ripple` preset, and in the core the box / image /
   Slug shaders as templates around `mat_vertex` / `mat_fragment`
   (`gpu/material.ts`), async material pipelines, material ids on records
   (`Scene.assign`) with batches cut by material, `graph.addMaterial` /
   `hideSource` / `nextMaterialId` / `materialsPending`. Contract:
   `src/fx/README.md` "Materials"; deviations: `docs/EFFECTS.md`.
   Verified in the sandbox: typecheck, biome, build; `test:visual` 0.00
   on all 23 shots (the templated default shaders are pixel-identical),
   `--with-fx` 0.00; `test:fx` all 26 rows OK incl. three exact on→off
   invariants and the DOM-hidden check for `fx-mat-bend`; `test:perf`
   same-session A/B against M2: full read 574 vs 884 ms (the sandbox was
   heavily loaded; earlier today M2 measured 355), 123 draws both,
   encode 0.40 ms both. An opus review found seven defects, all fixed
   before the final runs: batches could draw the wrong record range when
   a material sat between two plain records (the batch key now stays per
   layer, merging only on equal material and contiguous ranges),
   `mat_sample` sampled atlas images ~3 mips too coarse (gradients now
   scaled to the atlas entry), replace mode off un-hid a displaced target
   and `hideSource` ignored stop/start/destroy (requests are tracked in
   their own set), an invalid material pipeline would have voided whole
   frames (now async with a default fallback), material ids could clash
   between two `createEffects` runtimes (now allocated by the
   compositor), and the hooks' local frame differed between vertex and
   fragment for glyphs and box shadows. Try `/fx.html`: the materials
   section has ripple (click the image), wave, bend and stripes toggles.
   **M3b — built 2026-10-05, committed (`7a9f504`):**
   - Layer `simulate`: a compute hook with GPU-resident state,
     `set_data*`, `markDirty(first, n)`, `fx.dt` / `fx.steps`, and
     `Layer.steps`.
   - `Target.image` and Layer `image: target` (`image(uv)`).
   - Layer `glyphs: target`: the target's mirrored glyphs through Slug's
     coverage (`glyph_point/size/color/clip/coverage`).
   - `raw` materials: per-kind programs wrapping
     `default_vs` / `default_fs`.
   - TypeGPU externals `gpu` / `MatIn` / `Quad`; every layer and
     material hook also takes a tgpu.fn.
   Contract: `src/fx/README.md` (Layers, Materials, TypeGPU);
   deviations: `docs/EFFECTS.md` "Deviations (M3b)".
   Verified in the sandbox:
   - typecheck, biome, build;
   - `test:visual` 0.00 on all 25, `--with-fx` 0.00;
   - `test:fx` all 36 rows OK, incl. 9 new M3b shots (the new goldens
     reproduced on a second run) and an exact on→off invariant;
   - `test:perf` same-session A/B against the baseline: full read
     719 / 695 vs 674 ms (noise), 123 draws both, encode 0.4–0.5 ms
     both.
   An opus review found two real defects, both fixed before the final
   runs: `markDirty` ranges merged into one span, so with `simulate`
   two marks reset every instance between them (now kept apart); and
   `simulate` read last frame's pointer (the pointer is now written
   before the layers' frames). Smaller fixes from the same review:
   2D dispatch past 65535 workgroups, glyph points converted to the
   layer's space, and `glyph_clip`.
   Try `/fx.html`: the M3b section has toggles for heading glyphs, image
   tiles, simulated dots, a raw box, a 'use gpu' box material and a
   'use gpu' grey pass.
   **M3c follow-ons — built 2026-10-06, committed (`01c2a53`):** passes take
   `image: target` (`image(uv)` / `image_level` / `image_size()`, bind
   group 3); glyph materials get `mat_index(record)`, the glyph's stable
   index in the target (written into the Slug instance from
   `GlyphRun.glyphBase`, set by material tagging), and `fx.glyphs`.
   Contract: `src/fx/README.md`; deviations: `docs/EFFECTS.md`
   "Deviations (M3c)". New fx shots `fx-follow`, `fx-mat-stagger`,
   `fx-follow-then-off` (exact invariant), `fx-pass-image`. Verified:
   typecheck, biome, build; `test:fx` 41 OK; `test:visual` 0.00 on all
   27, `--with-fx` 0.00. An opus review found no correctness bugs; its
   three fixes are in (`fx.glyphs` now from the tagging count instead of
   rebuilding `target.glyphs` every frame, one text re-upload per
   rebatch with nested glyph materials instead of every one, `gpu.pass`
   image externals). Try `/fx.html`: "stagger (letters)" and "pass
   sampling the image". Perf not re-run: the text pass only gained one
   u32 write per glyph.
4. **Mirror leftovers — built 2026-10-05, committed (`718df5d`):**
   - Every `background-image` layer paints, in order, with the border on
     top (`backgroundLayerRecords`, now in `dom/backgrounds.ts`; also for
     pseudo-elements' gradient layers). `repeating-*-gradient` works, and
     url() layers take `background-size` lengths (`bgSize`).
   - Elliptical radii: `border-radius: 50%` on a non-square box,
     `60px / 24px`; `radiusY` on box / image / cutout records, `sd_box`
     in `gpu/sdf.ts`. Shadows are elliptical too since item 7.
   - `::selection` highlight boxes (Ben chose highlight only: selected
     text keeps its colour), re-read on `selectionchange`.
   - Square-cornered round-dot borders double the corner dots' AA as
     Chrome does (`outline` parity 1.31 → 0.53 %).
   - `cutouts: false` option; readout `fps` is the frames rendered in
     the last second; URL SVGs are sized from their fetched markup
     (same-origin, no `#fragment`).
   New visual shots `bglayers` and `bglayers-select` (`data-vr-select`);
   goldens for `outline`, `outline-focus`, `borderfill` updated (the
   corner dots and the 50% outline ellipse).
   Verified in the sandbox: typecheck, biome, build; `test:visual` 0.00
   on all 27 (new goldens reproduced), `--with-fx` 0.00; `test:fx` all
   36 OK; `test:perf` A/B: full read 472 vs 529 ms (noise), 123 draws
   both. An opus review found seven defects, all fixed: shadows and
   background images disagreeing with an elliptical box, a stale
   highlight after a select-all, the bottom gradient misplaced when the
   border split off, upper gradient layers ignoring `visibility`,
   pseudo-elements losing their top layers, the selection walk visiting
   the whole document on every drag step, and the SVG markup fetch
   logging cross-origin errors (now same-origin only, no fragments).
5. **Mirror batch 2026-10-05, uncommitted:** `outline` mirrored
   (`readOutline`), focus re-read (`DomSync.onFocus`), SVG sources
   rasterised at their concrete object size (`images/svgRaster.ts`;
   `images` parity 4.75 → 2.90 %), no cutout for ignored elements above
   the canvas. New visual shots `outline` and `outline-focus`
   (`data-vr-focus`).
6. **Upstream** the gvar issue (`docs/UPSTREAM-gvar.md`; repro checked
   against `playground/InterVariable.ttf` on 2026-10-06). Ben files it.
7. **Mirror batch 2026-10-06, uncommitted (on top of M3c):**
   - Conic and repeating-conic gradients; gradient layers honour
     `background-size`/`-position`/`-origin` (`gradient.tile`, packed in
     `gt`), `repeat-x`/`-y` per axis. Kind: 1 linear, 2 radial, 3 conic,
     + 8 repeating.
   - Slug curve budget `MAX_CURVES` 1024 (column bands double a glyph's
     stored curves).
   - Elliptical outer and inset shadows (`shadow_x`/`shadow_cov`), so
     elements with `box-shadow` keep elliptical corners.
   - `FAST_TEXT_READ` under a transform (`frameOf`/`pushPlaced`):
     perGrapheme 10.8k -> 2.7k, Range queries 15k -> 7.8k, 400-card page.
   - Text AA: Slug's dual rays (row + column bands), two rays per
     direction, `SLUG_GAMMA` 0.87, glyph quad grown a device pixel (thin
     `l`/`i` stems were clipped). Text parity 0.95 -> 0.36 %, every
     text-bearing shot improved; the `y` tail streak is gone.
   New visual shot `shapes` (incl. repeat-x and content-box origin); all
   visual and fx goldens re-taken (text). Opus review: no serious
   defects; its fixes (per-axis repeat, origin, `background-size` 0
   paints nothing, curve budget, `pow(0)` guard) are in. Perf: frame
   time +3 % under SwiftShader vs ffd452c (a CPU proxy; GPU time on real
   hardware not measured).
8. **`/duo` orbit, 2026-10-06, uncommitted.** Library: `progressiveBlur`
   preset (`src/fx/presets/progressiveBlur.ts`, shot `fx-progressive`).
   MDS-home: `Duo/Orbit.jsx` (`OrbitHero`: the hero plus a GSAP
   ScrollTrigger ring of screenshots under its image, scrubbed by
   scroll; progressive blur toward the image's bottom corners: the
   preset as a region pass on the ring when the compositor is active, a
   per-card CSS blur otherwise); `GpuCompositor` gained `onReady`;
   `index.jsx` renders `OrbitHero` in place of `Hero`. The site needs the
   submodule bumped to a compositor-gpu commit with the preset. Checked
   in a vanilla port on a playground page under SwiftShader (not in
   Gatsby). Placeholders are 8-bit PNGs: the 16-bit ones crash
   SwiftShader (ROADMAP).

## Gotchas

- The Cowork VM mounts the folders but cannot delete files or take git
  locks: file edits and `mv` work, `git checkout/commit/submodule` don't, and
  `node_modules` there is macOS-only, so harnesses run in a Linux sandbox on
  a copy of the tree (`pnpm install --frozen-lockfile`, `CHROMIUM_PATH` to a
  Playwright Chromium, `npm run test:visual`). Never run two harnesses at
  once there (screenshot timeouts), and don't edit `src/` or `playground/`
  during a run (the dev server reloads the page and the run dies).
- `test:visual` runs Chromium with `--disable-lcd-text` so DOM captures are
  grayscale-AA like macOS; parity numbers before that flag aren't
  comparable.
- Slug needs TTF/OTF/WOFF outlines (opentype.js can't read WOFF2): the
  `/duo` `@font-face` lists woff2 first for the browser and the variable TTF
  second for the compositor. Any element still on `system-ui` falls back to
  the Canvas atlas and looks aliased — `DuoFont.jsx` forces Inter with
  `#___gatsby *`.
- On headless Chromium + SwiftShader, importing a canvas into WebGPU fails;
  `gpu/upload.ts` detects it and reads back via `getImageData`. Textures are
  labelled, so a Dawn validation message names its destination.
- Base UI portals (nav popup) render into `<body>`, outside any wrapper —
  exclude them with `data-gpu-ignore` on the portal's positioner.
- gatsby develop's runtime-error overlay locks `body` scrolling
  (`body-locker`) and shows as a blank, unscrollable page if the overlay
  itself doesn't render; a Safari extension throwing on the site's JSON-LD
  caused a day of false "Safari scroll bug" (fixed in `SEO.jsx`, `@graph`
  form). Production is unaffected. Check `document.body.style.overflow`
  first next time.
