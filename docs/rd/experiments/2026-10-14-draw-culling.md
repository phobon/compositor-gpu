# Experiment: culling draws outside the canvas

| Field | Value |
| --- | --- |
| Activity | C2 (cost) — adviser to confirm; culling is a standard technique, the uncertainty is in how it fits this renderer's batches |
| Status | Concluded (partly supported) |
| Started | 2026-10-14 |
| Concluded | 2026-10-14 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-14-draw-culling/` |

## Hurdle

Every frame that redraws the scene submits every record on the page to the
GPU, including records far outside the canvas (the canvas covers the
viewport plus one viewport above and below). On `perf.html` (400 cards,
~4.8k elements, ~84k glyphs) most records are off the canvas, but their
vertex work still runs each frame. In the sandbox's software WebGPU
(SwiftShader, 2 CPUs) a steady frame on that page takes tens of seconds
(baseline below). How much of that, and of a real GPU's frame time, is
spent on off-canvas instances is not known.

## Why existing knowledge doesn't resolve it

View-frustum culling is standard in game engines and scene graphs, but
those cull objects that each own a draw call. Here draws are cross-layer
batches built in CSS paint order (`scene/batches.ts`): one draw covers a
contiguous instance range whose records can be scattered across the whole
page, because instance order follows paint order, not position. Merging
records into few large batches is what keeps the draw count low (~114
draws for `perf.html`). A batch's union rect usually spans most of the
page, so culling whole batches may remove almost nothing, and splitting
batches into on-canvas sub-ranges trades vertex work for more draw calls
and CPU work per frame. Which side wins on this renderer is not
documented anywhere; it depends on the page's paint order.

## Hypothesis

Splitting each draw batch into the contiguous instance runs whose records
intersect the canvas region (computed once per scene build and canvas
anchor, not per frame) cuts the instances submitted per steady frame on
`perf.html` by at least 60%, reduces SwiftShader steady frame time by at
least 40%, adds no more than 2x the draw calls, and changes no pixels
(visual harness 0.00% regression on every section).

## Why the outcome is uncertain

- Paint order may interleave on- and off-canvas records so finely that the
  runs become many short draws: draw-call overhead could cancel the vertex
  savings, or exceed the 2x budget.
- Recomputing runs costs CPU per scene build and per re-anchor (scrolling
  past the margin), which could show up as hitches.
- Records' rects are not the whole story: text shadows, box shadows and
  transformed layers paint outside their rects (batch builder already pads
  some), so a run boundary computed from rects could clip visible pixels.
- On a real GPU vertex cost for off-screen instances is small (clipped
  before rasterisation); the gain may only exist in software rendering.

## Method

1. Baseline (before any change): `npm run test:perf` on `perf.html`, n=400,
   in the sandbox (SwiftShader); record steady encode, steady fps and full
   read. Add an `instances` count to `stats()` (instances submitted in the
   last frame) as a hardware-independent measure of vertex work.
2. Change: per batch, the contiguous runs of instances whose (padded)
   rects intersect the canvas region, cached by scene build + canvas
   anchor; behind a `cullDraws` option (default on) so both can be
   compared in one build.
3. Measures: instances per steady frame, draws per frame, steady frame
   time (SwiftShader), CPU encode time; on Ben's Mac the GPU pass time from
   `npm run test:profile -- --headed`.
4. Pass/fail: thresholds in the hypothesis; `npm run test:visual` and
   `npm run test:fx` unchanged.

## Results

Environment: the cloud sandbox, headless Chromium 1194 with SwiftShader
(software WebGPU), 2 CPUs, viewport 1280x900, dpr 1. `perf.html`, n=400:
2723 boxes, 84168 glyphs, 400 images, 123 batches; document 29115 px tall,
canvas 2700 px (viewport plus one viewport above and below).

| Measure | Baseline (`cullDraws: false`) | Result (`cullDraws: true`) | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| Instances per steady frame | 75919 | 11357 (-85%) | -60% | 2026-10-14 | `2026-10-14-cull-vs-nocull.json.txt` |
| Draws per frame | 123 | 33 (-73%) | <= 2x | 2026-10-14 | same |
| Steady frame time, SwiftShader (4 frames, median) | ~14.4 s | ~12.7 s (-12%) | -40% | 2026-10-14 | same |
| CPU encode per steady frame | 0.3-0.5 ms | 0.3 ms | no increase | 2026-10-14 | same |
| Visual harness, GPU captures culled vs not | - | no difference attributable to culling (below) | 0.00% | 2026-10-14 | - |
| GPU time per frame, M1 Pro (scroll, p50 / p95) | 5.75 / 6.31 ms | 5.66 / 6.80 ms | -40% | 2026-10-14 | `2026-10-14-m1pro-profile-scroll.txt` |
| Main pass GPU time, M1 Pro (p50) | 5.23 ms | 5.27 ms | - | 2026-10-14 | same |

Real GPU: Ben's MacBook Pro (Apple M1 Pro, Metal), Chrome 155, headed,
120 Hz, dpr 1, `npm run test:profile -- --headed --only scroll` with and
without `--nocull`, 239 frames each, no late or dropped frames in either.

Baseline full `npm run test:perf` before the change (same sandbox):
`2026-10-14-baseline-perf.txt` and `2026-10-14-baseline-perf-last.json`
(full read 580 ms; steady encode 0.4 ms; steady fps 0.0).

Observations:

- Draw calls went down, not up: most batches lie wholly off the canvas
  and are skipped, and the visible ones rarely split into more than one
  run after merging gaps under 64 instances.
- Run boundaries are computed against the canvas region grown by half its
  size each way and cached until the canvas leaves that region, so records
  just outside the canvas (shadows, glyph ink overhang) are never cut and
  nothing is recomputed while scrolling within it.
- Pixels: the full visual suite was run with and without culling and every
  GPU capture compared. 26 of 36 were identical; 10 differed by 1-6286 px.
  Re-running sections alone: `boxes`, `stacking`, `transforms` and
  `bglayers` were identical culled and unculled. `backdrop`, `gradients`
  and `borderfill` switched between two or three outputs from run to run
  with culling on as well as off, and each culled output matched an
  unculled one. `images` (1 px), `bglayers-select` and `duo-s900` were not
  re-run. So the harness is not deterministic on some sections under
  SwiftShader (not known before; worth a separate look, S1), and no
  difference was traced to culling.
- The frame time barely moved: with 85% fewer instances, SwiftShader still
  spends ~12.7 s per frame, so the cost is in rasterising the 1280x2700
  canvas (fragment work on what is on it), not in vertex work for records
  off it.

## Evaluation

Partly supported. The instance and draw-call targets were met with room to
spare and no pixel change was found. The frame-time target was not met:
in software rendering the frame fell 12%, and on the M1 Pro GPU time did
not change measurably (p50 5.66 vs 5.75 ms, main pass 5.27 vs 5.23 ms,
p95 higher with culling on; the differences are within run-to-run noise).
On a real GPU, vertex work for off-canvas records costs next to nothing:
the triangles are clipped before rasterisation. The GPU time goes to
rasterising what is on the canvas: the main pass is ~5.3 ms and the
opacity-group passes ~3.2-3.5 ms, ~68% of the 8.33 ms budget at 120 Hz.

## Conclusion and next step

Known now: on this renderer, paint-order batches are spatially coherent
enough that per-batch run splitting removes most off-canvas instances and
also cuts draw calls, at negligible CPU cost. Culling is kept (default on,
`cullDraws: false` to compare).

On Apple silicon culling saves no measurable GPU time. It stays on: it
costs no measurable CPU, cuts draw calls by 73%, and helps software
rendering (and likely weaker GPUs). The cost to attack next is fill.

Next:

1. A new experiment on fill cost: the canvas covers three viewports and
   all of it is redrawn each frame, but only the viewport is visible
   between frames. Redrawing only the viewport (plus a band sized to the
   scroll speed) while the margins keep their last contents may cut
   fragment work by up to ~3x; the risk is stale or empty margin content
   showing during fast scrolls (the reason the margin exists, see C2
   hypothesis 1).
2. The opacity-group passes (`group`, ~3.2 ms p50 on the M1 Pro for 5
   groups on perf.html) are as costly as half the main pass; find out
   why (group texture sizes, the canvas margin applied to groups too).
3. The non-deterministic harness sections (above).

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
| Cull whole batches by their union rect | Simplest | Not built: a batch's union rect spans most of the page on long pages, so the run split was used from the start | 2026-10-14 |
| Cull against the exact canvas rect, recomputed per frame | Tightest cull | Rejected before building: recomputes ~90k rects on every re-anchor and in `canvasPin: 'viewport'` mode on every scrolled frame, and cuts records whose shadows or ink reach into the canvas | 2026-10-14 |
