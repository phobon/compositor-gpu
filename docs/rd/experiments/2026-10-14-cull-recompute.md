# Experiment: a cheap recompute for draw culling

| Field | Value |
| --- | --- |
| Activity | C2 (latency vs cost of the document-space canvas) |
| Status | Concluded (partly supported: p99 met in neither mode, max unchanged) |
| Started | 2026-10-14 |
| Concluded | 2026-10-14 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-14-cull-recompute/` |

## Hurdle

Draw culling (`gpu/cull.ts`) recomputes the visible instance runs when
the canvas, or the band with `canvasFill: 'band'`, leaves its cached
region. On `perf.html` (400 cards) a recompute costs up to 6.8 ms of
main-thread time on an M1 Pro (encode CPU p99 2.7-3.5 ms, max 4.8-6.8 ms
in `2026-10-14-band-culling.md`), against 0.1-0.4 ms per frame otherwise.
That is most of an 8.33 ms frame at 120 Hz, so a recompute during a
scroll is a likely dropped frame. In the default mode it should happen
about every 1.5 viewports of scrolling; the 2 s scroll scenario never
reaches one, so it hasn't been measured.

## Why existing knowledge doesn't resolve it

Spatial indexes for culling are standard (grids, BVHs), but the cost
here may not be the search: each recompute builds a rect object per
glyph (`padGlyphRect`) for every glyph on the page, and the garbage
those objects make is collected later, so where the time goes isn't
known from the code alone. Which structure is cheapest also depends on
paint order: runs are built in instance order, not y order, so an index
that finds visible instances still needs them back in paint order.

## Hypothesis

Computing each instance's culling bounds once per scene change into flat
typed arrays, so a recompute is a loop of number comparisons with no
allocation, brings encode CPU on a scroll that crosses the cached region
repeatedly to a p99 of at most 0.5 ms and a max of at most 1 ms on the
M1 Pro, in both `full` and `band` modes, with the same instance counts.

## Why the outcome is uncertain

- The loop still visits every instance on the page per recompute
  (~76k on perf.html); if that walk, not the allocation, is the cost, a
  y index is needed and the paint-order rebuild may cost as much.
- The bounds computed once per scene change move that cost to the frame
  after a re-read or re-sort; if it's as large as today's recompute,
  frames that already re-read get slower.
- Records changed in place without a re-sort would make cached bounds
  stale. The current cache is keyed on the same `scene.batches` identity,
  so this would already be a bug, but it hasn't been checked.

## Method

1. Baseline: a `scroll-long` scenario in `perf.html` (down 4800 px and
   back, in steps sized to the frame count, so it crosses the cached
   region in both modes), measured before the change.
2. Change: `gpu/cull.ts` keeps per-layer Float32Array bounds keyed on
   `scene.batches`; `cullRuns` reads them.
3. Measures: encode CPU p50 / p99 / max on `scroll-long` (`--nodim`, with
   and without `--band`), on the M1 Pro and in SwiftShader (the CPU
   columns are valid there); instances per frame unchanged
   (`test/fill/run.ts`); visual harness unchanged.

## Results

| Measure | Before | After | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| Encode CPU p50 / p95 / max, SwiftShader, `scroll-long`, full | 0.20 / 14.30 / 35.60 ms | 0.20 / 1.00 / 11.80 ms | - | 2026-10-14 | `2026-10-14-swiftshader.txt` |
| Encode CPU p50 / p95 / max, SwiftShader, `scroll-long`, band | 0.50 / 12.90 / 23.90 ms | 0.60 / 7.90 / 10.20 ms | - | 2026-10-14 | same |
| Instances per frame (full / band / band culled to canvas) | 14483 / 6294 / 14056 | 14483 / 6294 / 14056 | unchanged | 2026-10-14 | same |
| Encode CPU p95 / p99 / max, M1 Pro, `scroll-long`, full | 0.20 / 1.90 / 5.20 ms | 0.20 / 0.90 / 5.90 ms | p99 0.5, max 1 ms | 2026-10-14 | `2026-10-14-m1pro-profile-scroll-long.txt` |
| Encode CPU p95 / p99 / max, M1 Pro, `scroll-long`, band | 1.60 / 2.50 / 4.50 ms | 0.50 / 0.80 / 3.90 ms | p99 0.5, max 1 ms | 2026-10-14 | same |
| Dropped frames at 120 Hz, M1 Pro (all four runs) | 0 | 0 | - | 2026-10-14 | same |

Observations so far:

- The baseline confirms the hurdle in the default mode: on `scroll-long`
  in SwiftShader, `full` encode reached 35.6 ms (24 frames, 400 px steps).
- After the change the p95 falls 14x in `full` and 1.6x in `band`, but
  single recomputes still take up to 10-15 ms in the browser. Timed
  directly, `cullRuns` took 0.5-1.1 ms on most recomputes and 5.8-15.1 ms
  on a few (the first includes building the bounds). The same loop in
  Node takes 0.5-0.8 ms for 76k instances. In SwiftShader the GPU's
  rasteriser runs on the same CPU cores, so these spikes may be
  contention rather than the loop.
- On the M1 Pro, p99 fell 2x (full) and 3x (band), and band's p95 3x,
  but the worst frame did not move: 5.2 -> 5.9 ms in `full`, 4.5 -> 3.9
  ms in `band`, one frame per run. No reads ran during the scroll, so
  the bounds weren't rebuilt then; the spike is either the first
  recompute after load running before the loop is optimised (the Node
  benchmark's first call took 5x its later ones) or not culling at all.
  The profiler's `encode` row can't tell which.
- No run dropped a frame: at dpr 1 the M1 Pro absorbs a 6 ms CPU frame
  because the GPU frame is ~5 ms and they overlap. At dpr 2 (14 ms GPU,
  band culling experiment) or on slower machines it would not.
- Every read path rebuilds the scene and re-sorts (`rebuildScene`), so
  batches change whenever records do; bounds keyed on the batches can't
  go stale (checked in `dom/tree.ts`, including sticky re-reads).

## Evaluation

Partly supported. Precomputed bounds cut the recompute's p99 to 0.9 /
0.8 ms (from 1.9 / 2.5), short of 0.5 ms, and left one 4-6 ms frame per
run in both modes, against a 1 ms threshold. The allocation per glyph
was part of the cost, not all of it.

## Conclusion and next step

Known now: on an M1 Pro, walking every instance's bounds on a 400-card
page costs under 1 ms when warm, so the steady cost is close to the
threshold; one large frame per scroll remains and its cause is not yet
attributed. The change is kept (no loss anywhere, instance counts
identical).

Next:

1. Attribute the remaining spike: time `cullFor` itself (a
   `stats().cullMs` for the last recompute, and its maximum over the
   scroll in the profile report), and check whether it's the first
   recompute.
2. If it's culling, make the recompute proportional to what's visible:
   records bucketed by y per scene change, so a region visits only its
   buckets; and warm the loop once when the bounds are built.
3. If it isn't, find what else runs in `encode` on that frame.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
| Bounds per instance in typed arrays, computed once per batch list | Removes a rect allocation per glyph per recompute | p99 2-3x lower on the M1 Pro; worst frame unchanged | 2026-10-14 |
