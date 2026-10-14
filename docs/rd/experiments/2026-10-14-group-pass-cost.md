# Experiment: what the opacity-group passes cost on the GPU

| Field | Value |
| --- | --- |
| Activity | S1 (measurement validity), feeding C2 (cost) |
| Status | Concluded (partly supported) |
| Started | 2026-10-14 |
| Concluded | 2026-10-14 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-14-group-pass-cost/` |

## Hurdle

The frame profiler on Ben's M1 Pro (`2026-10-14-draw-culling/
2026-10-14-m1pro-profile-scroll.txt`) reports, per frame while scrolling
`perf.html`: GPU total 5.66 ms (p50), `main` pass 5.27 ms and `group`
passes 3.21 ms. The groups are the cards with `opacity: 0.8` (every 7th
card, ~57 on the page, a handful on the canvas at once), each a small
offscreen texture. 3.2 ms for a few card-sized passes would be the second
largest cost in the frame, but the numbers don't add up: main plus group
is 8.5 ms, more than the 5.66 ms from the first pass's begin to the last
pass's end. So either the group passes overlap the main pass on the GPU,
or the per-pass timings mean something other than GPU work.

## Why existing knowledge doesn't resolve it

The profiler sums each label's begin-to-end timestamp spans per frame
(`gpu/timer.ts`, `profile/profiler.ts`). WebGPU's `timestampWrites` only
promise a begin and an end time per pass; the spec doesn't say what work
falls between them. Apple GPUs render in tiles and can overlap one pass's
vertex stage with another's fragment stage, and Chrome's Metal backend
decides how passes map onto Metal encoders. How Chrome/Dawn on Metal
reports overlapping passes is not documented; whether the 3.2 ms is real
work can't be read off the existing report.

## Hypothesis

The `group` figure is mostly overlap with other passes, not extra GPU
work: removing every opacity group from `perf.html` changes the GPU total
per frame by less than 0.5 ms (p50) on the M1 Pro, and the time the group
passes run with no other pass running is under 0.5 ms per frame.

## Why the outcome is uncertain

- Each group texture is cleared, drawn and then sampled by the main pass;
  on a tiled GPU the clear and store of every group target could be real
  cost, and with ~5 groups per frame it could add up.
- The timestamps may be correct and the main pass may genuinely wait on
  the groups (a dependency stall), which would make the cost real even if
  it shows as overlap.
- Chrome's 100 µs timestamp quantisation could distort small spans.

## Method

1. Profiler: record each span's start offset in the frame and report, per
   label, the time it runs alone (no other label's pass running), next to
   the existing summed time. Hardware-independent change to the harness.
2. `perf.html?nodim` (and `test:profile --nodim`): the same page without
   the `opacity: 0.8` cards, so no opacity groups.
3. On the M1 Pro: `npm run test:profile -- --headed --only scroll` with and
   without `--nodim`. Compare GPU total and the `alone` figures.
4. Pass/fail: thresholds in the hypothesis.

## Results

| Measure | With groups | Without groups (`--nodim`) | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| GPU total per frame, M1 Pro (p50 / p95) | 5.53 / 7.02 ms | 4.63 / 5.68 ms | difference < 0.5 ms | 2026-10-14 | `2026-10-14-m1pro-profile-scroll.txt` |
| `group` summed per frame, M1 Pro (p50) | 2.63 ms | - | - | 2026-10-14 | same |
| `group` alone per frame, M1 Pro (p50 / p95) | 0.43 / 0.66 ms | - | < 0.5 ms | 2026-10-14 | same |
| `main` alone per frame, M1 Pro (p50) | 4.63 ms | 4.63 ms | - | 2026-10-14 | same |
| GPU total per frame, SwiftShader (p50, 7 frames) | 6398 ms | 6242 ms | - | 2026-10-14 | `2026-10-14-swiftshader-profile-scroll.txt` |

Observations:

- On the M1 Pro, of the 2.63 ms the group passes report, ~2.2 ms overlaps
  the main pass; they run alone for 0.43 ms.
- Removing the groups saves 0.90 ms p50 (16% of the GPU frame), about
  twice the group passes' alone time, so part of their cost shows up as
  the main pass running longer while they overlap it.
- In software rendering (passes run one after another, no overlap) the
  groups add only 2.4% (156 ms of 6398): there the group passes are
  mostly the dimmed cards' own drawing, moved from the main pass into
  their textures. On the tiled GPU each extra pass costs much more than
  its pixels.
- About 5 groups are on the canvas at once (every 7th card), so roughly
  0.18 ms per group per frame on the M1 Pro.

## Evaluation

Partly supported. The reported 2.63 ms is mostly overlap, as hypothesised
(alone 0.43 ms, under the 0.5 ms threshold). But the groups are not close
to free: they add 0.90 ms per frame, above the 0.5 ms threshold. The cost
scales with the number of group passes rather than with their area (the
same content costs 2.4% when drawn in the main pass in software, 16% as
separate passes on the M1 Pro), which points at per-pass overhead on a
tiled GPU: each pass clears and stores its own target.

## Conclusion and next step

Known now:

- Per-pass GPU timestamps on Chrome/Metal overlap; summed per label they
  overstate a pass's cost several times over. The profiler's `alone` rows
  (time with no other pass running) and an A/B without the feature are
  needed to read them. This applies to every earlier `group`, `layer` and
  `region` figure.
- Opacity groups cost ~0.18 ms each per frame on an M1 Pro, mostly per
  pass, not per pixel.

Next experiment (not started): render all the groups of a frame that don't
nest into one shared texture in a single pass (a group atlas: one clear,
one store, a viewport and scissor per group), instead of one pass per
group. Hypothesis to write first: on the M1 Pro it brings the group cost
from 0.90 ms to under 0.3 ms per frame on perf.html with no pixel change.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
| Reading the summed per-pass timings as cost | It was the existing report | Misleading on Metal: passes overlap; replaced by `alone` plus an A/B | 2026-10-14 |
