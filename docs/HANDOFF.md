# Handoff — compositor-gpu

Rewritten 2026-10-15 to resume in a fresh session. The 2026-10-08 version
(the `/duo` build-out, items 1-12) is in git history:
`git show b270d22:docs/HANDOFF.md`.

`ROADMAP.md` is the live checklist, `CLAUDE.md` the working notes for the
code, `docs/ARCHITECTURE.md` and `docs/EFFECTS.md` the specs,
`docs/rd/` the R&D records (experiments, evidence, activities). This file
is the context around them: where each checkout is, how a session works
with Ben, what the last rounds changed, and what is next.

## Where things are (2026-10-15)

| Path | Branch / position | State |
| --- | --- | --- |
| `~/code/compositor-gpu` | `main`, `b270d22 Atlas work`, pushed | Uncommitted: this file, `ROADMAP.md`, `docs/rd/activities-fy2026-27.md`, `test/fill/run.ts` (`--nodim`), `docs/rd/experiments/2026-10-15-reanchor-spread.md` and its evidence folder (the re-anchor experiment, concluded and reverted) |
| `~/code/bonobo/MDS-home` | `feature/duo_landing`, `8a03aa87 Content updates` | Clean. Submodule `compositor-gpu` at `ea80339` (Band fill experiments): behind `main` by the band default, blur downsample, edit patching and group atlas |
| `~/code/phobon.io` | `feature/slimming`, `9a4307b Bump compositor` | Uncommitted: `compositor-gpu` pointer, `package.json`, `pnpm-lock.yaml` (Ben's) |

Sites consume the library as a git submodule aliased to `src/`. Bump with
`git -C compositor-gpu fetch origin && git -C compositor-gpu checkout
origin/main && git add compositor-gpu && git commit` in the site. Claude
edits only the standalone `~/code/compositor-gpu` checkout, never a
submodule, and never `MDS-home/MDS-web-ui`.

## Start here

1. Commit the uncommitted R&D docs and the fill test flag in
   compositor-gpu (Ben reviews; Claude never commits).
2. Bump the submodule in MDS-home (and phobon.io when its own changes
   land) and look at both sites on the Mac at dpr 2. New defaults since
   `ea80339`: `canvasFill: 'band'` with kept margins, `patchEdits`,
   `groupAtlas`, and `blur` at half resolution from 8 device px of
   radius. Things to watch: blank strips after a long main-thread stall
   (there shouldn't be any), fixed headers during a stall, reveal/fade
   sections (group atlas), anything blurred (`fx` blur).
3. Then the next item from **Open items** below. Ben's order so far:
   importance to the sites first, then performance follow-ups.

## How a session works

Ben's standing rules (keep them):

- Never commit or push. Make changes, leave them uncommitted; Ben reviews
  the diff and commits.
- Surgical edits (small `Edit`s / scripted replacements), not file
  rewrites, to keep diffs reviewable and tokens down.
- Subagents: set `model` explicitly (haiku / sonnet / opus). Never spawn a
  `fable` agent without asking first.
- Plain prose in docs and replies; no mannered phrasing.
- compositor-gpu style: biome, single quotes, no semicolons, 80 columns.
  MDS-home: Prettier, no semicolons, single quotes, no trailing commas,
  arrow parens avoided, 80 columns, `.js`/`.jsx` only.

R&D records (`docs/rd/README.md` has the full workflow):

- Write the experiment file (`docs/rd/experiments/YYYY-MM-DD-slug.md`,
  from `templates/`) with hurdle, why existing knowledge doesn't resolve
  it, hypothesis with a measurable threshold, and why the outcome is
  uncertain, **before** writing code.
- Save every run's output to `docs/rd/evidence/<date-slug>/` (Ben's M1
  Pro runs verbatim, SwiftShader runs labelled as such).
- Conclude every experiment, including unsupported ones (results table,
  observations, evaluation, conclusion, alternatives tried). Add a row to
  the C2 table in `activities-fy2026-27.md` (newest first; rows 5-18 so
  far) and update `ROADMAP.md`.
- A reverted attempt keeps its code as a `.diff` in the evidence folder.

Tooling from a Cowork session:

- The connected folders are mounted on Ben's Mac; `node_modules` there is
  macOS-only, so builds and harnesses run in the cloud sandbox on a copy
  of the tree (`pnpm install --frozen-lockfile`;
  `CHROMIUM_PATH=/opt/pw-browsers/chromium`; headless falls back to
  SwiftShader).
- Getting changes onto the Mac: stage the device's originals
  (`device_stage_files`), `diff -ru` against the sandbox copy into
  `/mnt/user-data/outputs/<name>.patch`, `device_commit_files` it to
  `.stage-tmp/`, then on the device `patch -p1 < .stage-tmp/x.patch && rm
  -rf .stage-tmp` and compare md5s with the sandbox. Deleting needs Ben's
  approval once per session (`device_request_delete_permission`).
- Don't `npm install` in a tree with symlinks into the device (it pruned
  `@webgpu/types` once).
- Never run two harnesses at once, and don't edit `src/` or `playground/`
  while one runs (the dev server reloads and the run dies).
- Performance results that matter come from Ben's M1 Pro, headed:
  `pnpm test:profile -- --headed ...`. Give him exact commands, with
  `git stash push <files>` / `git stash pop` around a baseline run when the
  change has no option to turn it off.

## What the last rounds changed (2026-10-14/15)

Experiments in `docs/rd/experiments/`, all concluded:

| Experiment | Result | In the code |
| --- | --- | --- |
| draw-culling | Instances 85% fewer; no GPU change on the M1 Pro at dpr 1 | `gpu/cull.ts`, `cullDraws` (default on) |
| group-pass-cost | Profiler spans overlap on Chrome/Metal; real group cost 0.9 ms then | `alone` rows in the profile report |
| fill-cost | Band alone: -26% at dpr 1, blanks on stall | `canvasFill` |
| band-culling | Full canvas at dpr 2 misses 120 Hz (14 ms); band -53% | `cullDraws: 'canvas'` for A/B |
| cull-recompute, cull-spike, cull-index | One 1.5-6 ms recompute per scroll is the JIT's first call; y index helps in band mode | typed-array bounds, idle-built y index, `stats().cullMs`, profile `cull` row |
| band-margins | Kept texture: stall shows the same as `full`; 45-50% of full at dpr 2 | kept texture, `'band-clear'` for A/B |
| band-default | Stall checks match `full` on Metal (fixed header, up, blur) | **`canvasFill: 'band'` is the default**; post chains keep margins too |
| edit-cost, edit-patch | A one-word edit cost 31 ms (whole-scene rebuild + text re-pack); now 2.3 ms (class) / 11.8 ms (word swap) | `dom/patch.ts`, `Scene.replace`, partial text upload, `patchEdits` (default on), `test:edit`, profile rows `scene` / `batches` / `text` |
| blur-downsample | Frame with blur at dpr 2: 12.0 -> 7.5 ms, no dropped frames | `downsample` pass option, `blur` 3 stages |
| group-atlas | Leaf groups share one pass; small effect on perf.html (5 groups) | `groupAtlas` (default on), `stats().groupPasses` |
| reanchor-spread | Strips lowered p99 but raised p95; **reverted** | none (diff kept in evidence) |

Measuring notes learned along the way:

- GPU pass spans overlap on Chrome/Metal; compare `gpu total` and the
  `alone` rows, or A/B a feature off.
- Run-to-run spread on the M1 Pro is ~10% of the frame; effects smaller
  than ~0.5 ms need repeated runs.
- SwiftShader numbers are only good for CPU columns and proportions, and
  frames take seconds there, which changes scenario timing (two edits can
  land in one read).
- A scenario's rAF callback runs before the compositor's: editing every
  frame means each read sees two edits (`mutate-class` / `mutate-text`
  edit every other frame for that reason; `mutate` alternates kinds).
- `perf.html` stays on `canvasFill: 'full'` unless `?band` / `?bandclear`,
  so profile baselines keep their meaning. Other flags: `?nodim`,
  `?nocull`, `?bandcanvas`, `?nopatch`, `?noatlas`, `?fixed`.
- Cloud-sandbox baselines (container goldens, not regressions):
  `test:visual` fails textshadow, emoji, bglayers-select, selcolor-select,
  duo-s900; `test:fx` fails fx-trail*, fx-displace(-push), fx-dissolve.

## Open items (in ROADMAP order of importance)

1. **Rendering gaps** (next; affect how the sites look): text decoration
   styles done 2026-10-15 (`decorstyles` shot, parity 0.54%; solid line
   positions moved to Blink's formulas too, `decorations` 0.49 -> 0.34%);
   `mix-blend-mode` on a subtree done the same day (`blendgroup` shot,
   7.71 -> 0.73%), and pseudo content (`counter()`, quotes, `url()`,
   `list-style-image`; `gencontent` shot), text-shadow on pseudo text and
   inset shadows / content box on replaced elements (`shadowgaps` shot),
   16px-aligned image atlas entries; still open: multi-line pseudo text.
   Goldens of sections with decorations or images changed on purpose:
   run `test:visual -- --update` once on the Mac.
2. **Opacity edits** (`experiments/2026-10-15-opacity-patch.md`, done
   2026-10-16): a 48-element fade costs 4.3 ms CPU per frame (was 36.4)
   and keeps the display's pace. Left: the subtree re-read (2.2 ms) and
   record upload (1.5 ms) per frame, and the unmeasured hold-release
   rebuild 1 s after a fade. Scenarios: `test:profile --only
   scroll,groups,fade`, A/B with `--nopatchopacity`.
3. **16-bit PNG**: confirmed handled (`pngDepth.ts`, `png16` shot).
4. **Re-anchor tail**: done 2026-10-16 (`reanchorStrips`): `scroll-long`
   p99 at dpr 2 11.56 -> 8.09 ms. Left: the margin under budget is
   smaller than run-to-run spread; a SwiftShader-only 5 px at group/strip
   edges.
5. **Moved-glyph edits**: done 2026-10-16 (`refitBatches`): a word swap
   costs 1.9 ms (was 11.8-15.6). Left: ~1 ms of whole-buffer box/image
   upload per patched edit.
6. **Main pass + copy floor**: done 2026-10-16 (`skipUnchanged`,
   `experiments/2026-10-16-skip-unchanged.md`): scroll frames over
   unchanged content draw only rows not yet drawn or nothing; drawn
   frames ~2 ms at dpr 2 (was 7.5). Fixed content handled as damage
   2026-10-17 (~3 ms with a fixed bar, was ~6.9;
   `experiments/2026-10-17-fixed-damage.md`). Still redrawing every
   frame: `/fx` layers/materials and moving sticky elements.
7. Older items still open in ROADMAP: `calt`/`dlig`, atlas gutters,
   `url()` filters, external `<use href>`, perspective / 3D transforms,
   optional WebGL2 backend, spec deviation notes in `docs/EFFECTS.md`,
   `rollupTypes` d.ts, gvar upstream report (`docs/UPSTREAM-gvar.md`).

## Running it

```bash
# library, in the sandbox copy (or on the Mac for headed runs)
npm run typecheck && npm run lint && npm run build
npm run test:visual                 # DOM vs GPU parity + goldens
npm run test:fx                     # effects goldens (-- --only fx-blur)
npm run test:edit                   # patched edits vs a full rebuild
npm run test:atlas                  # image atlas eviction/compaction
npx tsx test/fill/run.ts [--headed] [--fixed] [--blur] [--up] [--nodim]
pnpm test:profile -- --headed --only scroll,scroll-long --nodim --dpr 2 --band
#   scenarios: idle scroll scroll-long mutate mutate-class mutate-text
#   full-read css-transforms fx-transforms reveal blur-scroll
npm run dev                         # playground: /, /fx.html, /perf.html

# site
cd ~/code/bonobo/MDS-home && yarn dev     # http://localhost:8000/duo?gpu=1&stats=1
```

`window.__gpu.stats()` has, among others: `fillRows`, `instances`,
`cullMs`, `partialReads` / `patchedReads`, `groups` / `groupPasses`.

## Gotchas

- `test:visual` runs Chromium with `--disable-lcd-text` (grayscale AA like
  macOS).
- Slug needs TTF/OTF/WOFF outlines (no WOFF2): list the TTF after the
  woff2 in `@font-face`. Anything on `system-ui` falls back to the Canvas
  atlas.
- Headless Chromium + SwiftShader can't import a canvas into WebGPU;
  `gpu/upload.ts` reads back via `getImageData`.
- Base UI portals render into `<body>`: exclude them with
  `data-gpu-ignore`. HelpScout's beacon is excluded the same way
  (`utils/HelpScoutBeacon.jsx` in MDS-home).
- gatsby develop's error overlay can lock `body` scrolling; check
  `document.body.style.overflow` before suspecting the compositor.
- From the device shell, read git state with `git --no-optional-locks`.
