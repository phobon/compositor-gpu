# Experiment: how much of the GPU frame time is real

| Field | Value |
| --- | --- |
| Activity | C2 (latency vs cost of the document-space canvas) |
| Status | Concluded (not supported: the GPU time is real) |
| Started | 2026-10-16 |
| Concluded | 2026-10-16 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-16-gpu-headroom/` |

## Hurdle

On an M1 Pro at dpr 2 with the band, `perf.html`'s scroll frames report
about 7 ms of GPU time (`gpu total` p50 6.6-7.6 ms across the
2026-10-16 sessions), against an 8.33 ms budget at 120 Hz. If that is
the work the frame puts on the GPU, there is about 1 ms left for
effects, the sites' own content and anything else the compositor adds,
and the floor (main pass plus copy) is the next thing to cut. The same
reports suggest it may not be: the main pass ran alone for 1.4 ms and
the copy for 0.5 ms, and the 11-12 ms frames that re-anchors produced
before `reanchorStrips` dropped no frames.

## Why existing knowledge doesn't resolve it

`gpu total` is the span from the frame's first timed pass beginning to
its last ending (`gpu/timer.ts`). On Chrome/Metal passes overlap and the
GPU also runs work outside the compositor's passes (Chrome's own
compositing of the page, other tabs), so the span can include time the
GPU spent on something else, or waiting. The `alone` rows give a lower
bound (time a label's passes ran with no other timed pass running), not
the frame's cost. Apple's tile-based GPUs also overlap the vertex work of
one frame with the fragment work of the previous one. Neither the span
nor the alone time says how much more GPU work a frame can take before
frames drop, which is what decides whether the floor matters.

## Hypothesis

Adding a known amount of fragment work to every frame's main pass
(`?ballast=N`, `playground/ballast.ts`: N rounds of arithmetic per
pixel in the band, writing nothing visible) on `perf.html` (n = 400,
`--nodim --dpr 2 --band`, M1 Pro, headed, `scroll`):

1. frames keep the display's pace (0 dropped, frame interval p95 within
   1 ms of no ballast) up to a ballast that raises the main pass's alone
   time by at least 4 ms, i.e. the frame's real GPU work is at most about
   4 ms of the 8.33 ms budget;
2. the ballast at which frames start dropping is measurable within the
   sweep (0 to 800 rounds), so the headroom has an upper bound too.

If frames start dropping with under 1.5 ms of added work, `gpu total` is
close to the real cost and the floor is worth cutting next.

## Why the outcome is uncertain

- The ballast runs inside the main pass, under the band's scissor, so
  its cost is fragment work only; if the frame's real cost is vertex or
  bandwidth bound (the copy pass), fragment ballast may overlap with it
  rather than add to it, and overstate the headroom.
- Chrome may pace frames to the display regardless of GPU load until a
  threshold, or drop them earlier because its own compositor shares the
  GPU; which, and where, isn't documented.
- Timestamps are quantised to 0.1 ms and passes overlap, so the ballast's
  own cost has to be read from the change in the main pass's alone time
  and span, which may not be linear in N.

## Method

1. `playground/ballast.ts`: an extra layer (`graph.addLayer`, `above`)
   drawing a full-target triangle in the main pass, N rounds per
   fragment, output transparent black under premultiplied blending (no
   visible change). `perf.html?ballast=N`, `test:profile --ballast N`.
2. Sweep on the M1 Pro, one session, N = 0, 25, 50, 100, 200, 400, 800:
   `test:profile --headed --only scroll --nodim --dpr 2 --band --ballast N`.
3. Per N: dropped and late frames, frame interval p50 / p95, `gpu total`
   and `main` span and alone p50 / p95.

## Results

| Measure | Baseline | Result | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| `scroll` frames dropped (of ~250) at N = 0 / 25 / 50 / 100 / 200 / 400 / 800, M1 Pro, headed, `--nodim --dpr 2 --band` | 0 at N = 0 | 0 / 23 / 76 / 177 / 57 / 0 / 0 (at 200-800 Chrome had dropped to 60, 30 and 17 Hz pacing, so drops are counted against a slower refresh) | 0 up to +4 ms of work | 2026-10-16 | `2026-10-16-m1pro-ballast-<N>.txt` |
| Frame interval p50 / p95, same | 8.30 / 9.10 ms | 8.30 / 16.20 (25), 8.60 / 16.90 (50), 16.50 / 17.30 (100), 24.2 / 25.7 (200), 33.4 / 41.8 (400), 66.0 / 67.2 ms (800) | p95 within 1 ms | 2026-10-16 | same |
| `gpu total` p50, same | 6.86 ms | 9.31 / 11.08 / 14.53 / 21.41 / 35.17 / 63.05 ms | report | 2026-10-16 | same |
| Linear fit of `gpu total` over N = 25-800 | - | 0.0693 ms per round + 7.57 ms (the layer itself adds ~0.7 ms over N = 0) | report | 2026-10-16 | same |
| `main` alone p50 with any ballast | 1.26 ms at N = 0 | 0.00 ms; the `copy` span grows with the main span (its begin timestamp comes before the main pass ends) | report | 2026-10-16 | same |

Observations:

- The ballast's cost is linear in N (0.069 ms per round) and adds to
  `gpu total` one for one: the frame's own ~7 ms is GPU time, not
  waiting. At 25 rounds (about +1.7 ms of work, `gpu total` 9.3 ms)
  frames already drop at 120 Hz; under sustained load Chrome then moves
  to 60, 30 and 17 Hz pacing.
- The `alone` rows don't measure cost on Metal: with any ballast the
  main pass's alone time is 0, because the copy pass's begin timestamp
  lands while the main pass is still running (the two are timed as
  overlapping although the copy depends on the main pass's output). The
  1.26 ms alone at N = 0 was the part of the main pass before the copy
  pass's begin, not the main pass's cost. `gpu total` is the number that
  predicts dropped frames.
- Single long frames don't drop (the 11-12 ms re-anchor frames earlier,
  and the 14.2 ms max at N = 0 here); sustained ones do. Chrome's
  pipelining absorbs one, not a run of them.

## Evaluation

Hypothesis 1 is not supported: frames drop with about 1.7 ms of added
work, far below the 4 ms predicted; the GPU time a scroll frame reports
(~7 ms at dpr 2) is real, and leaves about 1-1.5 ms under the 120 Hz
budget. Hypothesis 2 is supported: the onset lies inside the sweep,
between 0 and 25 rounds (0 and ~1.7 ms).

## Conclusion and next step

Known now: on this M1 Pro at dpr 2, a band-filled scroll frame of
`perf.html` occupies the GPU for ~7 ms of its 8.33 ms; the profiler's
`gpu total` is that occupancy and its per-label `alone` rows are not a
cost on Metal. The floor is worth cutting.

Next: most of the floor is redrawing the viewport and band (about 5 µs
per CSS row at dpr 2, `2026-10-16-reanchor-tail.md`). On a scroll frame
of a static page that redraw changes nothing: the canvas is in document
space and moves with the page, and the kept texture already holds the
band. Drawing only what changed (pending rows, viewport-space records,
dynamic layers), or no frame at all when nothing did, would take the
floor to the copy or to zero. That is the next experiment.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
