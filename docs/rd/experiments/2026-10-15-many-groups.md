# Experiment: dozens of opacity groups in view

| Field | Value |
| --- | --- |
| Activity | C2 (low-latency DOM-to-GPU synchronisation at pixel parity; opacity groups) |
| Status | Concluded (hypothesis 1 supported, hypothesis 2 not) |
| Started | 2026-10-15 |
| Concluded | 2026-10-15 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-15-many-groups/` |

## Hurdle

Every element below opacity 1 is an opacity group: its records render
into an offscreen texture every frame, then composite once. The group
atlas (`2026-10-15-group-atlas.md`) puts a parent's leaf groups in one
texture and one render pass, but it was measured with five groups in
view, where the groups cost ~0.1-0.3 ms either way and the effect was
inside run-to-run spread. The sites' reveal animations (staggered bento
cards, split-text lines faded in by GSAP / Motion) put dozens of elements
below opacity 1 at once. How the groups' cost grows with their number,
with and without the atlas, is not known, and neither is the cost of the
frames of such a fade: an opacity change makes or removes a stacking
context, so a partial read can't be patched (`dom/patch.ts`) and the
scene is rebuilt on every frame of the fade.

## Why existing knowledge doesn't resolve it

The group-atlas experiment showed the pass count falls from one per group
to one per parent, but its page had too few groups to show the scaling.
What dominates with many groups is open: the passes (removed by the
atlas), the per-group work that stays inside the shared pass (a frame
uniform, viewport and scissor per group, one composite draw each), the
atlas texture's area (cleared and stored as a whole; it grows with the
groups' total area), or, during a fade, the CPU side (a scene rebuild and
batch build per frame). Profiles of other renderers don't transfer: the
mix depends on this compositor's batching, culling and band fill.

## Hypothesis

On `perf.html` (n = 400, `--nodim`, M1 Pro, headed, dpr 2 with the band):

1. With 48 leaf elements in view held at opacity 0.6 while scrolling
   (scenario `groups`), the groups' cost per frame (`groups` minus
   `scroll`, compositor GPU + CPU p50) is at most 1.5 ms with the atlas,
   and at most 40% of the same cost with `--noatlas`.
2. A staggered fade of the same 48 elements by inline `style.opacity`
   (scenario `fade`, the GSAP route) keeps the frame interval p95 at or
   under 16.7 ms (no dropped frames at 60 Hz), with the CPU split showing
   whether the per-frame rebuild or the groups dominate.

## Why the outcome is uncertain

- The per-group work left inside the atlas pass (a uniform write and a
  bind group per group, a composite instance each) may grow with the
  count and erase the pass saving.
- 48 groups' total area may not fit one atlas texture (packing falls back
  to a texture per group), or a large atlas may cost more to clear and
  store than the separate small targets.
- During the fade, every frame changes which elements are groups (one at
  opacity 1 isn't one), so the batch list and the atlas packing change
  every frame; the rebuild's CPU cost at this scene size (~4.8k
  elements, ~84k glyphs) on every frame is unmeasured.

## Method

1. `playground/perf.ts`: scenarios `groups` (the first 48 of the in-view
   cards' `h3`, `p` and `li` elements set to opacity 0.6, then the
   `scroll` scenario's 8 px per frame down and up, then restored) and
   `fade` (the same elements from opacity 0 to 1 over 60 frames,
   staggered by 2 frames, through inline style). `?groups=N` sets the
   count (default 48); `test:profile --groups N` passes it.
2. Runs, each in one session, same machine:
   `pnpm test:profile -- --headed --dpr 2 --band --nodim --only scroll,groups,fade`
   then the same with `--noatlas`, then both again with `--groups 16`
   for the scaling. SwiftShader runs in the sandbox for CPU columns and
   pass counts only.
3. Measures: compositor CPU p50 / p95 (read, upload, encode), GPU p50
   (`group` pass label and its `alone` row), frame interval p95,
   dropped frames, `stats().groupPasses`, `groups`.
4. Baseline: `scroll` in the same session.

## Results

| Measure | Baseline | Result | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| `fade` compositor CPU p50 / p95, SwiftShader, n = 120, 1000x700 (`scroll`: 0.4 / 0.9) | - | 31.4 / 45.4 ms: read 16.0 (scene rebuild 13.3, of it batches 7.1), upload 11.1 (text re-pack 10.0), encode 2.0 | report | 2026-10-15 | `2026-10-15-swiftshader.txt` |
| `groups` compositor CPU p50 while scrolling, SwiftShader, same | 0.4 ms | 0.7 ms (`group` pass label present) | report | 2026-10-15 | same |
| Groups' cost per frame, 48 groups, atlas (GPU total p50 +0.60, CPU p50 +0.10 over `scroll`), M1 Pro, dpr 2, band, `--nodim` | `scroll` 6.66 ms GPU | 0.70 ms | at most 1.5 ms | 2026-10-15 | `2026-10-15-m1pro-48.txt` |
| Same, `--noatlas` (GPU +2.00, CPU +0.10) | `scroll` 6.67 ms GPU | 2.10 ms | - | 2026-10-15 | `2026-10-15-m1pro-48-noatlas.txt` |
| Atlas cost as a share of `--noatlas`, 48 groups | - | 33% | at most 40% | 2026-10-15 | both |
| Groups' cost per frame, 16 groups, atlas / `--noatlas` | `scroll` 7.30 / 6.65 ms GPU | -0.03 (none measurable) / 0.75 ms | - | 2026-10-15 | `2026-10-15-m1pro-16*.txt` |
| `group` pass span / alone p50, 48 groups, atlas / `--noatlas` | - | 0.59 / 0.02 ms and 25.2 / 0.37 ms | - | 2026-10-15 | 48 files |
| Entering or leaving 48 groups at once (one partial read that rebuilds) | - | 50-58 ms CPU (read ~27, upload ~24), 5-6 frames dropped each way | report | 2026-10-15 | 48 files |
| `fade` compositor CPU p50 / p95, 48 elements, atlas | `scroll` 0.20 / 0.30 | 32.4 / 36.7 ms: read 11.1 (scene 9.1, of it batches 6.1), upload 18.2 (text 17.2), encode 2.5 | - | 2026-10-15 | `2026-10-15-m1pro-48.txt` |
| `fade` mean frame interval (compositor frames over the scenario's time; the report's pacing columns read 0 because no frame was paced) | 8.3 ms | 38 ms (78 frames over 3.0 s); 16 elements: 37 ms | p95 at most 16.7 ms | 2026-10-15 | 48 and 16 files |
| `fade` CPU p50 across runs: 48 / 48 noatlas / 16 / 16 noatlas | - | 32.4 / 33.8 / 32.6 / 34.4 ms | - | 2026-10-15 | all four |
| `fade` GPU total p50, 48 elements, atlas / `--noatlas` | `scroll` 6.66 | 13.15 / 15.35 ms (main pass 12.66 / 13.74) | - | 2026-10-15 | 48 files |

Observations (SwiftShader, CPU only):

- Every frame of `fade` is a partial read that rebuilds the scene, as
  expected: an element crossing opacity 1 adds or removes a stacking
  context. The rebuild and the text re-pack (the whole text buffer, not
  the replaced runs) are most of the frame's CPU. At n = 120 that is
  already ~31 ms in the sandbox; `perf.html` defaults to n = 400.

Observations (M1 Pro, headed, dpr 2, band, `--nodim`, n = 400):

- Held groups scale as the atlas predicts: without it each group costs
  about 0.04 ms of GPU time per frame (0.75 ms for 16, 2.0 ms for 48);
  with it 16 groups are not measurable and 48 cost 0.6 ms. The `group`
  pass span falls from 25 to 0.6 ms at 48.
- Entering and leaving the 48 groups (setting their opacity in one task)
  costs one 50-58 ms frame each way: the partial read rebuilds the scene
  and re-packs the whole text buffer.
- `fade` costs ~33 ms of compositor CPU per frame whatever the count (16
  or 48) and with or without the atlas: it is the per-frame rebuild
  (scene ~9-11 ms, batches 6-8 ms of it) and the full text re-pack
  (~17 ms), not the groups. The compositor ran at ~26 fps (38 ms
  between frames) for the whole fade.
- The GPU also doubles during `fade` (13.2 ms against 6.7 ms scrolling),
  in the main pass. Likely because every rebuild is a new batch list:
  the cull cache is dropped and the band is redrawn whole rather than
  only its newly covered rows. Not verified separately.
- One unattributed 133 ms hitch in the 48-group `groups` run (6.7 ms of
  GPU in the frame before); it doesn't recur in the other runs.

## Evaluation

Hypothesis 1 is supported: 48 held groups cost 0.70 ms per frame with the
atlas (threshold 1.5 ms), 33% of the 2.10 ms without it (threshold 40%),
and the cost without the atlas grows linearly at ~0.04 ms per group.

Hypothesis 2 is not supported: a fade of 48 elements runs at ~26 fps,
not 60. The groups are not the reason (16 elements and `--noatlas` give
the same CPU); every frame of the fade rebuilds the scene and re-packs
all text because an opacity change on its own can't be patched.

## Conclusion and next step

Known now: the group atlas keeps dozens of held opacity groups under a
millisecond on an M1 Pro, so the group count is not what limits reveal
animations. What limits them is the read path: an opacity change rebuilds
the whole scene and re-uploads all text (~33 ms CPU per frame on a
4.8k-element page), and a group appearing or disappearing is what forces
that rebuild.

Next experiment: let an opacity-only edit avoid the rebuild. Two parts to
test: (a) an element whose opacity changes between values below 1 keeps
its group and only the group's alpha is updated (no re-read of its
subtree's records); (b) an element that has recently been below 1 stays
a group at opacity 1 for a short time, so a fade's start and end don't
change the stacking structure either. Threshold to set: `fade` CPU p50
under 4 ms on the same page. Separately, a rebuild that leaves the text
runs unchanged need not re-pack the text buffer.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
