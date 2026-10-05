# Handoff — compositor-gpu + bonobolabs.com `/duo`

Rewritten 2026-10-03, updated 2026-10-05 (M2), to resume in a fresh
session. `ROADMAP.md` is the live checklist (mirror phases + effects
milestones), `docs/ARCHITECTURE.md` the
mirror's spec, `docs/EFFECTS.md` the effects layer's. This file is the
context around them: checkouts, how to run and verify things, and the first
move on each open item.

## Where things are

| Path | What | Position |
| --- | --- | --- |
| `~/code/compositor-gpu` | the library, source of truth | `16df20b fx pass` = `origin/main` (the batch below, `ab273c8`..`16df20b`) + the uncommitted M2 batch (open item 3) |
| `~/code/bonobo/MDS-home` | the Gatsby site, branch `feature/duo_landing` | `0b9e327b Bump submodule` (pointer → `1094210 Cutouts`), 1 ahead of origin, + uncommitted `src/components/Duo/GpuCompositor.jsx` (`zIndex` prop, default 500) and `GpuStats.jsx` (readout line) |
| `~/code/bonobo/MDS-home/compositor-gpu` | git submodule | checked out at `199a186 Set canvas z index` (≠ the committed pointer); `origin/main` is `16df20b` |

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

1. **Commit.** Nothing from 2026-10-03 on is committed yet. In
   compositor-gpu: the M2 batch (item 3) plus these docs. In MDS-home:
   bump the submodule to `origin/main` once M2 is pushed (`git -C
   compositor-gpu fetch origin && git -C compositor-gpu checkout
   origin/main`), then commit it with `GpuCompositor.jsx` (`zIndex`) and
   `GpuStats.jsx` (readout line `cutouts / anchorY / reanchors`, added
   2026-10-05: the readout never showed them). Ben checked `/duo` on
   2026-10-05: solid apart from item 2.
2. **`/duo` findings (Ben, 2026-10-05).**
   - "The Bonobo Bundle →" and the scroll-top button render twice in Arc
     and Safari. Not reproduced in Claude's browser pane (Chromium, 607
     and 1280 px wide, overlay): `cutouts` 3, canvas `zIndex` 500, and
     with the DOM copy at opacity 0 nothing is drawn under it. Both live
     in `ScrollTop`'s fixed container (z 999, `transform` transition)
     under `SharedLayout`'s `GpuIgnore` (`display: contents`), so the
     mirror only cuts a hole there. First move: a screenshot from Arc
     with `&stats=1`, then `__gpu.stats()` and the container's rect vs
     the hole (`__gpu.scene.cutouts`) at the moment it doubles; check
     whether the doubling is the slide-in transition (holes don't follow
     transitions on an ignored element).
   - Replace mode: hover works; focus rings and keyboard focus show only
     on DOM (ignored) chrome. `outline` is not mirrored at all, and focus
     changes trigger no read: mirror `outline`/`outline-offset` as a box
     outside the border box, and re-read the element on
     `focusin`/`focusout` (`:focus-visible` changes no attribute).
   - Drag-select doesn't show in replace mode (`::selection` not
     mirrored). Ben: expected; no decision yet on mirroring it.
3. **Effects M2 — built 2026-10-05, uncommitted.** Target, Layer
   (`above` / `below` / `after`), region Pass, `cursorGlow`,
   `clickRipple`, `displace` `mode`; the core's `graph.addLayer` /
   `isolate` / `nodeOf` / `version`. Contract: `src/fx/README.md`;
   deviations: `docs/EFFECTS.md`. Verified in the sandbox: typecheck,
   biome, build, `test:visual` 0.00 regression everywhere (the core
   changes are inert without `/fx`), `--with-fx` 0.00, `test:fx` 0.00
   on all 17 shots incl. both invariants (the five M1 shots are
   pixel-identical to the pre-M2 tree; `fx-blur-then-off-on` differs by
   ±1 on 65 px, the page got taller), `test:perf` full read 355 ms, 123
   draws, encode 0.30 ms idle / 0.35 ms with blur (0.40 before: the
   copy-through now skips the scissored rect). An opus review found five
   defects, all fixed before the final run: region groups never went back
   to the pool (a new texture per frame), an `after` layer could escape
   an enclosing group that starts on its element (anchors now carry the
   enclosing-group depth), `nodeOf` returned stale nodes for removed /
   `display: none` elements (the map is reset per full read and pruned per
   partial read), writes inside a Layer's `update` re-requested frames
   forever, and a layer could draw a grown `count` before uploading it.
   Have a look at
   `fx-displace-push` (push folds through the centre: keep it or prefer
   a pinch?) and try the new panel toggles in `npm run dev` → `/fx.html`.
   Next: M3 (Materials) per `docs/EFFECTS.md`.
4. **Mirror leftovers**, one quiet batch: doubled AA on corner dots (Chrome
   paints each corner dot twice), multi-layer `url()` backgrounds (only layer
   0 paints), text under CSS transforms still reads per grapheme, a `layers`
   opt-out for cutouts, readout `fps` as a windowed count instead of an EMA,
   stacked `repeating-linear-gradient` backgrounds not drawn (found while
   building `fx.html`), and SVG `<img>` ignores `object-fit` (the playground
   `svg, contain` tile draws stretched to 150×100; most of `images`' 4.75 %
   parity, present since `4386398`): `ImagePass.upload` rasterises the SVG at
   the box size and passes that as the natural size, so `fit()` sees the
   box's aspect. Rasterise at the SVG's intrinsic aspect (scaled to cover
   the fitted rect at device px) instead. Plus `outline` / focus (item 2).
5. **Upstream** the gvar issue (`docs/UPSTREAM-gvar.md`).

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
