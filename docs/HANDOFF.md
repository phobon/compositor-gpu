# Handoff — compositor-gpu on bonobolabs.com `/duo`

Written 2026-09-29 to resume in a fresh session. `ROADMAP.md` is the live
checklist and has the ordered next steps under "Where to pick up"; this file
is the context around it: where things are, how to run them, what is
uncommitted, and the first concrete move for each open problem.

## Repos and checkouts

Three working trees matter, all on the Mac:

| Path | What | Position |
| --- | --- | --- |
| `~/code/compositor-gpu` | the library, source of truth | `d9141da` + 9 modified files (below) |
| `~/code/bonobo/MDS-home` | the Gatsby site (bonobolabs.com) | `1fb37ab8` + the `/duo` wiring (below) |
| `~/code/bonobo/MDS-home/compositor-gpu` | git submodule, `git@github.com:phobon/compositor-gpu.git` | `d9141da` + the same 9 files copied in |

The submodule is what the site actually runs (`compositor-gpu` →
`compositor-gpu/src` alias in `gatsby-config.js` / `jsconfig.json`). While
iterating, changes were copied into both the main checkout and the
submodule working tree so the dev server sees them without a push. To get
back to a clean flow: commit + push in `~/code/compositor-gpu`, then in
MDS-home `git -C compositor-gpu checkout -- . && git -C compositor-gpu pull`,
then commit the pointer.

**Committed:** `d916275 Scroll-driven canvas` (everything up to the
document-scrolling canvas) is on `origin/main`, and mds-home `ea95f754`
points the submodule at it.

**Uncommitted in compositor-gpu (2026-09-30 batch c, standalone checkout
only — the submodule is left for `fetch`/`checkout`):** `CLAUDE.md`,
`ROADMAP.md`, `docs/UPSTREAM-gvar.md` (new), `playground/index.html`,
`src/boxes/boxRenderer.ts`, `src/compositor.ts`, `src/dom/backgrounds.ts`,
`src/dom/styles.ts`, `src/dom/textRuns.ts`, `src/dom/tree.ts`,
`src/dom/observer.ts`, `src/images/imageRenderer.ts`,
`src/scene/records.ts`, `src/scene/stacking.ts`, `src/types.ts`,
`test/perf/run.ts`, `src/boxes/cutoutPass.ts` (new), `src/scene/scene.ts`,
`src/scene/batches.ts`. Contents: (0) `data-gpu-ignore` elements now punch
HOLES in the mirror (`CutoutRecord`, a `cutouts` layer drawn
destination-out at the element's paint-order z) so the site's nav, footer,
scroll-to-top and nav popup show through in overlay and replace mode —
before, body's opaque mirrored background covered them; and replace mode
no longer blanks a page that has ignored chrome (`HIDDEN_ATTR` carries the
pre-hide opacity so the reader ignores the hiding). An ignored
`display: contents` wrapper (how `SharedLayout`'s `GpuIgnore` works) puts
the holes on its children; attribute changes and CSS animations on a hole
element re-read its parent so the hole follows (deeper mutations stay
unwatched); (1) dashed/dotted borders fitted per side
(square corners) or along the inset centre path (rounded), matching
Blink's `SelectBestDashGap` rules and Skia's chord-measured arc lengths —
the `/duo` placeholder border is now pixel-identical, `duo` parity
1.15 → 0.56; (2) `url()` backgrounds honour `background-clip` /
`background-origin`, tile into the border area, and snap to device pixels
like boxes (`ImageRecord.originInset`, shared `boxInset` helper, border
split into a border-only box when an image reaches under it);
(3) `FAST_TEXT_READ` in `dom/textRuns.ts`: one `getClientRects()` per text
node, then per-chunk / per-grapheme fallbacks, with canvas-measured splits
verified against the browser rect within 0.05 px — Range queries on
perf.html 84k → 15k, full read ~26% faster, geometry within 0.031 px,
`stats().textRead` counts the fallbacks. Typecheck, biome, test:visual
(all parity ≤ previous; goldens rewritten), test:perf (full read 425 ms,
123 draws) and test:site (1.10/1.24/1.05%) pass in the sandbox. Full diff
of this batch: `_staging/compositor-gpu-changes.diff` (`_staging/` is
untracked; delete after reading).

**MDS-home:** clean at `ea95f754` (Duo wiring, SEO `@graph` fix,
submodule pointer). Next bump after committing batch (c): `git -C
compositor-gpu fetch origin && git -C compositor-gpu checkout origin/main
&& git add compositor-gpu && git commit`.

Git runs from the Cowork VM leave lock files it cannot delete
(`.git/index.lock`, `.git/modules/compositor-gpu/index.lock`); remove
any that exist before git work.

## Running it

```bash
# site
cd ~/code/bonobo/MDS-home && yarn dev        # http://localhost:8000
open 'http://localhost:8000/duo?gpu=1&stats=1'          # overlay + readout
open 'http://localhost:8000/duo?gpu=1&stats=1&debug=1'  # + library console log
open 'http://localhost:8000/duo?gpu=1&mode=replace'     # DOM paint hidden

# library, from ~/code/compositor-gpu
npm run typecheck && npm run lint
npm run test:visual                      # 20 playground sections
npm run test:site -- --url http://localhost:8000/duo --scroll 0,600,1200
npm run test:perf
```

`window.__gpu` is the compositor on the page; `__gpu.stats()` returns the
readout's numbers. The readout shows: `fps` (compositor) and `raf`
(the page's own rAF rate, measured independently), `frame` (our per-frame
wall time), `worst gap` (longest inter-frame gap in the last second),
read/upload/encode ms, the `dirty:` counters (why the mirror was
invalidated, cumulative), `animating` (elements tracked as running CSS
animations), `last:` (most recent mutation target), and `fallbackSamples`
(graphemes drawn by the Canvas 2D atlas and why).

Reference numbers, Chrome on the M-series Mac: read 0.7 ms idle, upload
0, fallback 0, `dirty` flat at idle. Safari: `frame 49 ms` (46 ms full
read), `raf 60`.

## Open problems, first move for each

1. **Safari — closed.** Both symptoms (scroll lock, 8 s stall on load)
   were gatsby develop's runtime-error overlay (`body-locker`), triggered
   by a Safari extension's injected script throwing on the site's
   array-form JSON-LD (`r["@context"].toLowerCase` at `duo:3`). Fixed in
   mds-home `src/components/utils/SEO.jsx` (schema emitted as
   `{ "@context", "@graph": [...] }`, uncommitted); the compositor was
   never involved and production was never affected. Remaining Safari
   work is perf only: the full read is ~65× Chrome's (per-grapheme
   `Range.getBoundingClientRect`); if profiling shows that is the floor,
   batch reads per text node with `getClientRects()` in `dom/textRuns.ts`.
2. **Scroll-frame lag / 60 fps.** Overlay mode repositions the GPU layer
   from the `scroll` event, one frame after the browser's compositor thread
   has scrolled the DOM, so two offset copies show per scroll frame. Check
   `raf` vs `fps` in the readout on the ProMotion display while scrolling:
   `raf 120` / `fps 60` means the loop is only woken by scroll events —
   drive it off rAF for the duration of a scroll (`compositor.ts` `onScroll`
   → `scheduler.request()`). The structural fix is a document-scrolling
   canvas: `position: absolute`, viewport + margin tall, re-anchored only
   when the viewport leaves it, so the compositor thread moves it with the
   page. Replace mode hides the double image in the meantime.
3. **Replace mode on the real page.** `?mode=replace`: check hover, focus,
   selection and links still work (opacity keeps hit-testing), and that the
   excluded nav/footer stay painted (an ancestor of an ignored element keeps
   its own background — see `hideUnder` in `compositor.ts`).
4. **Fidelity gaps on `/duo`** (Phase 3 list): background under translucent
   borders (the placeholder's `rgba(0,0,0,.2)` dashed border shows the fill
   through it in Chrome; the box shader draws border over fill), pixel-
   snapped 1px borders, `text-transform` (reader uses the source text's code
   points; CSS-uppercased lowercase draws lowercase outlines) and
   `letter-spacing` (per-grapheme rects include tracking; the ink box should
   not stretch with it) in `dom/textRuns.ts`.
5. **Upstream** the opentype.js gvar fix (`src/text/slug/gvarFix.ts`, a
   packed point count of 0 means "all points") as an issue/PR on
   opentypejs/opentype.js so the runtime patch can go.

## Gotchas

- The Cowork VM mounts the folders but cannot delete files or take git
  locks: file edits and `mv` work, `git checkout/commit/submodule` don't, and
  `node_modules` there is macOS-only, so harnesses run in a Linux sandbox
  with a copy of the tree (`pnpm install`, `CHROMIUM_PATH` to a Playwright
  Chromium, `npm run test:visual`).
- `test:visual` runs Chromium with `--disable-lcd-text` so DOM captures are
  grayscale-AA like macOS; parity numbers before that flag aren't
  comparable.
- Slug needs TTF/OTF/WOFF outlines (opentype.js can't read WOFF2): the
  `/duo` `@font-face` lists woff2 first for the browser and the variable TTF
  second for the compositor. Any element still on `system-ui` (mds-web-ui's
  `Heading` sets it by class) falls back to the Canvas atlas and looks
  aliased — `DuoFont.jsx` forces Inter with `#___gatsby *`.
- On macOS headless Chromium + SwiftShader, importing a canvas into WebGPU
  fails; `gpu/upload.ts` detects it and reads back via `getImageData`.
  Textures are labelled, so a Dawn validation message names its destination.
- Base UI portals (nav popup) render into `<body>`, outside any wrapper —
  exclude them with `data-gpu-ignore` on the portal's positioner.
