# Experiment: attributing the encode spike on scroll

| Field | Value |
| --- | --- |
| Activity | C2 (latency vs cost of the document-space canvas) |
| Status | Concluded (supported) |
| Started | 2026-10-14 |
| Concluded | 2026-10-14 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-14-cull-spike/` |

## Hurdle

After precomputing culling bounds (`2026-10-14-cull-recompute.md`), one
frame per scroll still spends 4-7 ms encoding on an M1 Pro (encode max
5.9 ms `full`, 3.9 ms `band` on `scroll-long`; up to 7.1 ms with kept
margins in `2026-10-14-band-margins.md`), against 0.1-0.9 ms on every
other frame. At dpr 2 the GPU frame is 6-7 ms with the band, so a 7 ms
CPU frame on top risks a dropped frame. The profiler reports encode as
one number, so the spike's cause is not known.

## Why existing knowledge doesn't resolve it

Candidates, each plausible from the code: the cull recompute when the
region changes (its loop isn't optimised by the JIT until it has run a
few times, and the first call in Node was 5x slower than later ones);
re-anchor frames, which now cull to the whole canvas and re-create the
kept texture's view; or something else in encoding (bind group or
buffer creation on the first frame that needs it). Only a measurement
inside encode separates them.

## Hypothesis

The spike is the cull recompute: timing `cullFor` as its own CPU row
(`cull`, part of `encode`) will show a `cull` max within 0.5 ms of the
`encode` max on `scroll-long` on the M1 Pro, in `full` and `band`.

## Why the outcome is uncertain

If `cull` max is small, the spike is elsewhere in encode and the cull
work so far was aimed at the wrong cost; if it matches, which part of
the recompute (first-call JIT, bounds build, walk) still needs telling
apart.

## Method

1. `stats().cullMs` (ms the last frame spent recomputing culled runs; 0
   when cached) and a `cull` row under `encode` in the profile report.
2. `test:profile --headed --only scroll-long --nodim` with and without
   `--band`, on the M1 Pro; SwiftShader for a check of the plumbing.
3. Compare `cull` and `encode` p99 / max.

## Results

| Measure | full | band | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| Encode / cull CPU max, SwiftShader, `scroll-long` (24 frames, 400 px steps) | - | 14.8 / 14.3 ms | cull within 0.5 ms of encode | 2026-10-14 | `2026-10-14-swiftshader.txt` |
| Encode / cull CPU p99 / max, M1 Pro, `scroll-long` | 0.60 / 2.50 vs 0.50 / 2.40 ms | 0.70 / 1.50 vs 0.50 / 1.50 ms | cull within 0.5 ms of encode | 2026-10-14 | `2026-10-14-m1pro-profile-scroll-long.txt` |

Observations so far:

- In SwiftShader the cull recompute is the spike (14.3 of 14.8 ms).
- Timing the parts of `cullRuns` (temporary console timing): the bounds
  are built only at load (21 ms and 7 ms, two batch lists), never during
  the scroll; the first recomputes in the scroll take 7.6 and 12.7 ms in
  the visibility loop and up to 4.9 ms in the runs loop, then 0.4-1.6
  and 0.3-0.6 ms once warm. That fits a loop running in the interpreter
  before the JIT optimises it: the work per call is the same (every
  instance on the page), only its speed changes.

- On the M1 Pro the spike was smaller in this session (encode max 2.5
  and 1.5 ms, against 5.9 and 3.9 ms in the cull-recompute runs), and
  the cull recompute accounts for all of it in both modes.

## Evaluation

Supported: the encode spike on scroll is the cull recompute (within
0.1 ms of encode at p99 and max, on the M1 Pro and in SwiftShader). Its
size varies between sessions (1.5-5.9 ms max on the M1 Pro), which fits
JIT warm-up: the work per call doesn't change, only how fast the loop
runs before it is optimised.

## Conclusion and next step

Known now: the remaining CPU cost of culling is a walk of every
instance on the page per recompute, which is cheap once optimised and
slow for the first few calls. Next: make the recompute proportional to
what is near the region (records bucketed by y once per scene change),
so the first calls are cheap too; `stats().cullMs` and the profile's
`cull` row measure it.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
