# Experiment: a y index for draw culling

| Field | Value |
| --- | --- |
| Activity | C2 (latency vs cost of the document-space canvas) |
| Status | Concluded (not supported on the M1 Pro: band max improved, full didn't, neither met the threshold) |
| Started | 2026-10-14 |
| Concluded | 2026-10-14 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-14-cull-index/` |

## Hurdle

The cull recompute walks every instance on the page (~76k on
`perf.html`) twice: once to test bounds, once to build each batch's
runs. Optimised, that is under 1 ms on an M1 Pro; the first calls after
load run before the JIT optimises the loops and take 1.5-5.9 ms (12.7
ms in SwiftShader), the one slow encode per scroll
(`2026-10-14-cull-spike.md`). The work grows with page length, not with
what is on screen, so longer pages make it worse.

## Why existing knowledge doesn't resolve it

Spatial indexes are standard; the open question here is the second
walk. Runs must come out in paint order per batch, and a y index finds
visible instances out of that order, so they have to be sorted back.
Whether a sort of the visible set (a native typed-array sort) plus a
binary search per batch is cheaper than the plain walk when cold, and
no slower when warm, isn't known in advance.

## Hypothesis

Bucketing each layer's instances by y (512 CSS px buckets, built once
per scene) and building runs from the sorted visible set gives the
same runs as the walk, and brings the `cull` row's max on `scroll-long`
on the M1 Pro to at most 0.5 ms in `full` and `band`, with p50 not
worse.

## Why the outcome is uncertain

- Records that span many buckets (page backgrounds, long text runs'
  boxes) are listed in each, so a region may still visit many entries.
- The sort and the per-batch binary searches add work the walk didn't
  have; with ~10k visible instances in a 3-viewport region, they may
  cost as much as the walk did once warm.
- Building the index adds to the frame that re-reads the page.

## Method

1. `gpu/cull.ts`: per layer, a CSR bucket index over the cached bounds
   (bucket start offsets and instance lists, viewport-space instances
   kept apart as always visible); a region visits its buckets, marks
   instances once (a stamp array), sorts them, and each batch's runs
   come from a binary search into that list. Revised while measuring
   (see Alternatives): queries walk every rect until the index exists,
   and the index is built in idle time 250 ms after a batch list's first
   query.
2. Check: runs identical to the walk on `perf.html` (instance counts in
   `test/fill/run.ts`) and on random synthetic scenes (a script
   comparing both on many regions).
3. Measures: `cull` row p50 / p99 / max on `scroll-long --nodim`, `full`
   and `--band`, M1 Pro (before: `2026-10-14-cull-spike.md`) and
   SwiftShader.

## Results

| Measure | Before (walk) | After (index) | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| Runs identical to the walk, random scenes | - | 2600 checks, 0 mismatches | identical | 2026-10-14 | `2026-10-14-swiftshader.txt`, `equivalence-check.mts` |
| Instances per frame, `test/fill/run.ts` (full / band / band culled to canvas) | 14931 / 6294 / 14289 | 14931 / 6294 / 14289 | identical | 2026-10-14 | same |
| `cull` CPU max, SwiftShader, `scroll-long` (full / band) | 13.3 / 14.3 ms | 5.3 / 4.9 ms | - | 2026-10-14 | same |
| `cull` CPU p50, SwiftShader, `mutate` (re-sort every frame) | 12.4 ms | 16.1 ms (9.9-16.1 over three runs) | not worse | 2026-10-14 | same |
| `cull` CPU p99 / max, M1 Pro, `scroll-long` full (walk: two runs) | 0.50 / 2.40, 0.40 / 2.60 ms | 0.50 / 2.90 ms | max 0.5 ms | 2026-10-14 | `2026-10-14-m1pro-profile.txt` |
| `cull` CPU p99 / max, M1 Pro, `scroll-long` band (walk: two runs) | 0.50 / 1.50, 0.50 / 3.90 ms | 0.60 / 1.00 ms | max 0.5 ms | 2026-10-14 | same |
| `cull` CPU p50 / max, M1 Pro, `mutate` (walk: two runs) | 2.40 / 5.50, 2.40 / 5.10 ms | 2.40 / 4.50 ms | not worse | 2026-10-14 | same |

Observations so far:

- Building the index with the bounds (on every re-sort) tripled the
  cull cost on `mutate` in SwiftShader (38 ms p50 against 12.4 ms), so
  that design was dropped. Building it on the second query instead
  moved the cost into a scroll frame (43.6 ms max on `scroll-long`). The
  final design builds it in idle time once a batch list has lasted 250
  ms, so neither a re-sorting frame nor a scroll frame pays for it.
- In SwiftShader the worst scroll recompute fell from ~14 ms to ~5 ms;
  `mutate`, which never builds an index, varies 9.9-16.1 ms between runs
  of the same code, so the walk's 12.4 ms isn't clearly different.

- A first set of "after" runs on the M1 Pro turned out to have run the
  walk (the stash hadn't been popped); they are kept as extra walk
  runs. With the walk, the worst recompute was 2.4-2.6 ms (full) and
  1.5-3.9 ms (band) across runs.
- With the index: full 2.9 ms max, band 1.0 ms max (p99 0.5-0.6 ms both).
  The band result is below every walk run; the full result is not.
  `scroll-long` leaves the full-mode cached region after ~280 ms, close
  to when the idle index can first exist (250 ms plus an idle period),
  so in full mode the first recompute may still be a walk. Single runs
  each, with a spread of several ms between runs, so neither result is
  firm.
- `mutate` costs the same either way (cull 2.4 ms p50); it never builds
  an index, as designed.
- `mutate` shows a much larger cost elsewhere: each text edit spends
  10.7-11.1 ms reading and 18.0-18.5 ms uploading instance buffers on
  the M1 Pro (32 ms CPU per frame, a 58 ms hitch from a 33 ms upload).

## Evaluation

Not supported: neither mode reached 0.5 ms max on the M1 Pro. The index
cut the cold recompute in SwiftShader (14 to 5 ms) and band mode's on
the M1 Pro (1.0 ms against 1.5-3.9 ms with the walk), but not full
mode's (2.9 against 2.4-2.6 ms), possibly because full mode's first
recompute comes before the index is built. Its runs are identical to
the walk (2600 random checks) and it costs nothing on pages that
re-sort every frame (`mutate` unchanged).

## Conclusion and next step

Known now: on fast hardware the culling recompute is a 1-4 ms cost once
per page, not a frame-rate problem; an index helps once it exists, and
whether it exists before the first scroll decides how much. The cost that does drop frames is the text-edit path:
~11 ms of read and ~18 ms of upload per edit on `perf.html`.

Decision on the index (keep or revert to the walk): Ben's. Next
experiment proposed: the per-edit read and upload cost.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
| Index built with the bounds on every re-sort | Simplest: always ready | `mutate` cull 38 ms p50 vs 12.4 ms in SwiftShader: every re-sorting frame pays for an index it uses once | 2026-10-14 |
| Index built on a batch list's second query | Skips pages that re-sort every frame | The build lands in the first scroll frame (43.6 ms max in SwiftShader) | 2026-10-14 |
