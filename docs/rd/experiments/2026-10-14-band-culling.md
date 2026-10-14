# Experiment: culling draws to the band, and the band at dpr 2

| Field | Value |
| --- | --- |
| Activity | C2 (latency vs cost of the document-space canvas, hypothesis 1) |
| Status | Concluded (not supported at dpr 1; the band itself supported at dpr 2) |
| Started | 2026-10-14 |
| Concluded | 2026-10-14 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-14-band-culling/` |

## Hurdle

`canvasFill: 'band'` draws 43% of the canvas rows on `perf.html` but cost
74% of the full main pass on the M1 Pro at dpr 1 (3.78 vs 5.09 ms p50,
`2026-10-14-fill-cost.md`), so it missed its 40% threshold. Which part of
the remaining 31 points is work the scissor doesn't remove is unknown:
vertex and tile-binning work for records outside the band, or the clear
and store of the whole 3-viewport target. Separately, all fill numbers so
far are at dpr 1; a Retina display draws four times the pixels.

## Why existing knowledge doesn't resolve it

Apple's GPU documentation describes tile-based deferred rendering
(geometry is binned per tile before fragment work) but not what a
scissored pass costs for geometry outside the scissor or for the
attachment's clear and store outside it. The draw-culling experiment cut
instances 85% (75.9k to 11.4k, culled to the canvas) with no measurable
change on the M1 Pro (`2026-10-14-draw-culling.md`), which suggests vertex
work is small, but that was with the whole canvas drawn, where fill
dominated.

## Hypothesis

With `canvasFill: 'band'`, culling draws to the band (instead of to the
canvas) cuts the band's main pass GPU time on the M1 Pro at dpr 1 so that
the total cut against `full` reaches at least 40% (p50, `perf.html
--nodim`, scroll), because the gap between the rows drawn (43%) and the
time taken (74%) is vertex and binning work for records outside the band.

Second measure, no threshold: the share of the main pass `band` saves at
dpr 2, with and without culling to the band.

## Why the outcome is uncertain

- Culling to the canvas showed no GPU change on this machine, so vertex
  work may already be negligible; then culling to the band changes
  nothing and the gap is the attachment's clear and store, which a
  scissor can't remove on a canvas texture.
- At dpr 2 the fragment work is four times larger while vertex work is
  the same, so the share saved by the band may move towards the area
  ratio, or the larger target's clear and store may dominate further.
- Run-to-run spread on the M1 Pro is ~10% (fill-cost observations), so a
  small effect may not be separable in single runs.

## Method

1. `gpu/renderer.ts`: with `canvasFill: 'band'`, `fillBand` keeps the band
   in document space and `cullFor` culls to it (grown by half a viewport
   for caching) instead of to the canvas. `cullDraws: 'canvas'` keeps the
   old cull region, for the A/B. `perf.html?bandcanvas` and
   `test:profile --bandcanvas` select it.
2. Runs on the M1 Pro, headed, `--only scroll --nodim`, each at `--dpr 1`
   and `--dpr 2`: full; `--band --bandcanvas` (the fill-cost
   configuration); `--band` (culled to the band). Same in SwiftShader.
3. Measures: main pass GPU p50 / p95 / p99 (total and `alone`), CPU per
   frame, `stats().instances`.
4. Baseline: the full and `--bandcanvas` runs of the same session.

## Results

| Measure | full | band, culled to canvas | band, culled to band | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- | --- |
| Instances per frame, perf.html (scrolled to 3000 px) | 14483 | 14056 | 6294 (-55% vs culled to canvas) | - | 2026-10-14 | `2026-10-14-swiftshader.txt` |
| Canvas rows drawn per frame (900 px viewport) | 2700 | 1156 | 1156 | - | 2026-10-14 | same |
| Main pass GPU p50, SwiftShader (`--nodim`, 12 frames) | 5804 ms | 2412 ms | 2442 ms | - | 2026-10-14 | same |
| CPU per frame p50, SwiftShader | 0.40 ms | 0.30 ms | 0.40 ms | no increase | 2026-10-14 | same |
| Main pass GPU p50 / p99, M1 Pro, dpr 1 | 5.30 / 6.12 ms | 3.99 / 8.28 ms (75%) | 4.61 / 8.61 ms (87%) | band culled to band at most 60% of full | 2026-10-14 | `2026-10-14-m1pro-profile-scroll.txt` |
| Main pass GPU p50 / p99, M1 Pro, dpr 2 | 14.14 / 14.71 ms | 6.69 / 6.83 ms (47%) | 5.97 / 6.65 ms (42%) | report | 2026-10-14 | same |
| Dropped frames at 120 Hz, M1 Pro, dpr 2 | 170 of 251 | 0 of 258 | 0 of 258 | - | 2026-10-14 | same |
| CPU per frame p50 / p99 / max, M1 Pro, dpr 1 | 0.10 / 0.30 / 0.40 ms | 0.20 / 0.40 / 0.80 ms | 0.20 / 2.70 / 4.80 ms | no increase | 2026-10-14 | same |
| CPU per frame p50 / p99 / max, M1 Pro, dpr 2 | 0.10 / 0.30 / 0.40 ms | 0.10 / 0.30 / 0.40 ms | 0.10 / 3.50 / 6.80 ms | no increase | 2026-10-14 | same |

Observations so far:

- Culling to the band works as intended: it halves the instances the band
  submits, and the pixels drawn don't change (rows and the stall check
  match the canvas-culled band).
- In software rendering it makes no difference to GPU time: the cost
  there is the pixels drawn, as in the fill-cost experiment.
- At dpr 1 on the M1 Pro, culling to the band didn't help: 4.61 ms
  against 3.99 ms culled to the canvas. The difference is within the
  ~10% run-to-run spread seen before plus some; it is not a saving.
- At dpr 2 the picture changes. The full canvas takes 14.14 ms on the
  main pass, over the 8.33 ms budget at 120 Hz, and 170 of 251 frames
  are dropped (the hitch report blames the GPU). The band cuts the main
  pass 53% (culled to canvas) and 58% (culled to band), and no frames
  are dropped. Culling to the band saves 0.72 ms here (11%).
- At dpr 2, 4x the pixels made the full pass 2.7x slower but the band
  only 1.7x, so the band's saving tracks the area much more closely at
  real density than at dpr 1.
- Culling to the band adds CPU spikes: encode p99 2.7 ms and max 4.8 ms
  at dpr 1, 3.5 / 6.8 ms at dpr 2. `cullFor` recomputes when the band
  leaves its cached region (the band plus half a viewport), and
  `cullRuns` walks every record and glyph on the page, a few ms on
  perf.html. Culled to the canvas, the cached region is half a canvas
  (1.5 viewports) each way, which this 2 s scroll never leaves; a longer
  scroll in the default `full` mode would hit the same recompute, every
  1.5 viewports (not measured).

## Evaluation

Hypothesis not supported: at dpr 1 the band culled to the band took 87%
of the full main pass (threshold 60%), no better than the band culled to
the canvas. So the gap at dpr 1 is not vertex or binning work for
records outside the band; the remaining candidate is the clear and store
of the whole target. At dpr 2, the density Mac users actually run, the
band alone clears the 40% threshold of the fill-cost experiment (-53%)
and the full canvas does not fit a 120 Hz frame on this machine.
Culling to the band adds 11% at dpr 2 but costs main-thread spikes of
up to 6.8 ms, so as built it is not a net gain.

## Conclusion and next step

Known now: at dpr 2 on an M1 Pro, filling the 3-viewport canvas is the
whole frame budget at 120 Hz on a 400-card page; the margins, not the
viewport, are most of that cost; and draw culling's recompute is a
CPU cost of several ms on a page this size.

Next:

1. Make the cull recompute cheap (records sorted or bucketed by y once
   per scene change, so a new region is a range lookup), then re-measure
   culling to the band. This also affects the default mode on long
   scrolls.
2. Reduce what a full redraw fills at high dpr: keep the band's speed
   without its stall risk, by keeping the margins' last contents (a
   persistent scene texture redrawn in the band, copied to the canvas),
   or by a smaller `canvasMargin` when dpr is high.
3. `canvasFill` stays `'full'` by default until one of those removes the
   blank-on-stall cost; `cullDraws` keeps culling to the band in band
   mode (the option is experimental), with the spike recorded here.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
