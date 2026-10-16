# Experiment: small, culled strips for a re-anchor's new rows

| Field | Value |
| --- | --- |
| Activity | C2 (latency vs cost of the document-space canvas, hypothesis 1) |
| Status | Concluded (supported, except the p95 threshold, missed by 0.14 ms) |
| Started | 2026-10-16 |
| Concluded | 2026-10-16 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-16-reanchor-tail/` |

## Hurdle

With `canvasFill: 'band'` the frame that re-anchors the canvas draws the
band and the rows the canvas newly covers (about a viewport) at once. On
an M1 Pro at dpr 2 that puts `scroll-long`'s GPU p99 at 10.35-11.19 ms
against an 8.33 ms budget at 120 Hz (`2026-10-14-band-margins.md`,
`2026-10-15-reanchor-spread.md`), once per viewport scrolled. No frames
drop at 60 Hz, but every re-anchor is a missed 120 Hz frame.

## Why existing knowledge doesn't resolve it

`2026-10-15-reanchor-spread.md` drew the new rows in strips of an eighth
of the canvas (337 CSS rows at dpr 2), each as a second draw of the
batch list culled to the whole canvas. p99 fell to 9.12 ms but p95 rose
from 7.30 to 8.81 ms. It concluded that the second draw's geometry work
was the cost. Its own numbers fit another reading as well: across the
dpr 2 runs, GPU total is close to linear in the rows drawn (`full`, 2700
rows: 14.2 ms; band, ~1156 rows: 6.4 ms; about 5 µs per CSS row plus
0.6 ms). That predicts ~11 ms for a re-anchor frame (band plus ~900 new
rows) and ~8.1 ms for a strip frame (band plus 337 rows), against 11.2
and 8.8 ms measured. So both the strip size and the second draw's extra
geometry may matter, and which dominates is not known.

Two further points the earlier experiment didn't separate:

- After any re-anchor the main draw is culled to the whole canvas (grown
  by half of it), not the band, and that cull stays cached for the
  following band frames (`cullFor`: the band lies inside the cached
  region). `test/fill/run.ts` shows it: band draws 28.5k instances,
  `full` 15.0k.
- The strip's size was fixed. The rows only have to stay ahead of the
  scroll; a strip sized to the recent scroll steps adds far fewer rows
  per frame.

## Hypothesis

On a re-anchor the newly covered rows are cleared and become pending;
each frame draws the band (culled to the band) and then one strip of
pending rows nearest the band, of `max(96, 2 × largest scroll step of the
last 200 ms)` CSS rows, as a second draw culled to the pending rows
(`reanchorStrips`, default on; off is the current behaviour). On the M1
Pro, headed, `perf.html` n = 400, `--nodim --dpr 2 --band`:

1. `scroll-long` GPU total p99 at most 8.33 ms (11.19 ms before), p95 at
   most 7.8 ms (7.30 before) and p50 at most 5% above the same session's
   run without strips.
2. `scroll` GPU p99 no higher than without strips.
3. The stall checks (`test/fill/run.ts`, down / up / fixed / blur, and
   `--nodim`) differ from `full` by no more than they did before (0 / 40 /
   40 / 0 px in SwiftShader; 0 px headed).

## Why the outcome is uncertain

- If the second draw's cost is mostly geometry that culling doesn't
  remove (vertex and binning of every batch's draw call, not its
  instances), any frame with a strip pays it and p95 rises as before.
- Smaller strips take more frames to fill a viewport of rows (about ten
  at 96 rows), so a main-thread stall soon after a re-anchor reveals more
  cleared rows than before. The stall check stalls ~28 frames after its
  last jump; a stall earlier than that is not covered by it.
- The earlier experiment saw a small difference from `full` in
  SwiftShader where an opacity group crosses a strip's edge, cause not
  found. Smaller strips cross more groups.

## Method

1. `gpu/renderer.ts`, starting from `reanchor-spread-renderer.diff`:
   pending rows from `keepMargins` (cleared on the re-anchor frame,
   shifted with the texture on later ones); `nextStrip` sized from the
   band's scroll steps; the band's own cull kept on strip frames; the
   strip drawn with runs culled to the pending rows (cached until they
   change); a strip that touches the band is drawn as part of it (one
   draw). Backdrops in the scene: the rows drawn at once, as now.
   While rows are pending the loop keeps running (`compositor.ts`:
   `continued`) and the post chain doesn't reuse the scene
   (`reuseKey`), so the strips finish on a still page.
   `CompositorOptions.reanchorStrips` (default true), `perf.html?nostrips`,
   `test:profile --nostrips`; `stats().pendingRows`.
2. Checks: visual and fx harnesses, stall checks, SwiftShader.
3. Measures (M1 Pro, one session):
   `pnpm test:profile -- --headed --only scroll,scroll-long --nodim --dpr 2 --band`
   with and without `--nostrips`; the stall checks headed.

## Results

| Measure | Baseline | Result | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| Stall checks px differing from `full`, SwiftShader: down / up / fixed up / blur / `--nodim` | 0 / 9 / 9 / 0 / 0 (`reanchorStrips: false`, same run) | 5 / 9 / 9 / 5 / 0 | no more than before | 2026-10-16 | `2026-10-16-swiftshader.txt` |
| Blank viewport rows in the same checks | 34 / 39 / 88 / 33 / 33 | equal | equal | 2026-10-16 | same |
| Visual harness, SwiftShader | regression column of HEAD, same session | identical on every section | no change | 2026-10-16 | same |
| fx harness, SwiftShader | - | all shots 0.00 | no change | 2026-10-16 | same |
| `scroll-long` GPU total p50 / p95 / p99 / max, M1 Pro, headed, `--nodim --dpr 2 --band` | 7.55 / 8.08 / 12.00 / 12.69 ms (`--nostrips`, same session; the old code twice before it: 7.57 / 8.11 / 11.95, 7.59 / 7.96 / 12.08) | 7.58 / 8.29 / 8.63 / 8.66 ms | p99 at most 8.33, p95 at most 7.8, p50 at most +5% | 2026-10-16 | `2026-10-16-m1pro.txt`, `-nostrips.txt`, `-baseline-a.txt`, `-baseline-b.txt` |
| `scroll` GPU total p99 / max, same | 8.12 / 8.40 ms (`--nostrips`) | 9.13 / 14.52 ms | p99 no higher | 2026-10-16 | same |
| Stall checks headed, M1 Pro, px differing from `full`: down / up | 0 / 4 (`bandnostrip`, same run) | 0 / 4 | no more than before | 2026-10-16 | `2026-10-16-m1pro-fill.txt` |
| After the interval fix: `scroll-long` GPU total p50 / p95 / p99 / max, M1 Pro, same flags | 7.30 / 7.68 / 11.56 / 11.62 ms (`--nostrips`, same session) | 7.32 / 7.94 / 8.09 / 9.20 ms | p99 at most 8.33, p95 at most 7.8, p50 at most +5% | 2026-10-16 | `2026-10-16-m1pro-run2.txt`, `-run2-nostrips.txt` |
| Same, `scroll` p50 / p95 / p99 / max | 6.66 / 7.29 / 8.64 / 16.35 ms | 6.64 / 6.83 / 7.77 / 9.19 ms | p99 no higher | 2026-10-16 | same |
| Same, frames dropped (`scroll-long`) | 0 | 3, in one 33.9 ms hitch 0.04 s into the scenario, attributed outside the compositor (GPU 9.2 ms max) | report | 2026-10-16 | same |
| Stall check headed, M1 Pro, after the fix: px differing from `full`, down | 0 (`bandnostrip`) | 0 | no more than before | 2026-10-16 | `2026-10-16-m1pro-run2-fill.txt` |

Observations (SwiftShader):

- The first version drew strips only on frames something else asked
  for: once the scroll settled the loop stopped with rows still pending
  (484 device rows in the stall check, 210 blank viewport rows), and
  with the blur chain on, still frames reused the scene and drew none.
  Pending rows now keep the loop running and turn scene reuse off.
- The 5 px with opacity groups (down and blur variants, at most 11/255,
  text edges inside one dimmed card) are the difference seen in
  `2026-10-15-reanchor-spread.md` where a group crosses a strip's
  edge. Cause still not found; it doesn't appear with `--nodim`, and the
  earlier experiment didn't see it on Metal.

Observations (M1 Pro, first run):

- The first runs of the old code (`-baseline-a/-b`) were made before the
  change was on the machine; with the `--nostrips` run they give three
  same-day baselines that agree within 0.15 ms at p50 and p99. This
  session's frames are about 1.1 ms slower at p50 than on 2026-10-15
  (7.55 against 6.41 ms), across the board; the p95 threshold of 7.8 ms
  was set from the older session, and this session's own baseline is
  already above it (7.96-8.11 ms).
- `scroll-long`: the re-anchor frames are gone from the tail (max 12.69
  to 8.66 ms, p99 12.00 to 8.63), with p50 unchanged and p95 +0.21 ms.
  p99 is 0.3 ms over the 120 Hz budget.
- `scroll` got one 14.5 ms frame (main pass 13.9 ms, near `full`'s cost)
  that it didn't have before. The scenario reverses direction. The
  pending rows were one interval: after re-anchors at both ends it
  became the span from the new rows at one end to the old ones at the
  other, which holds the band, and a band inside the pending rows drew
  them all at once, about the whole canvas. Pending rows are now kept as
  separate intervals (rows between them were drawn) and a strip always
  comes from the interval nearest the band.
- No difference from `full` on Metal in the stall checks beyond what the
  old code shows (0 and 4 px); the 5 px seen in SwiftShader with groups
  doesn't appear.

Observations (M1 Pro, after the fix):

- `scroll-long` p99 fell from 11.56 to 8.09 ms and its max from 11.62 to
  9.20 ms; p50 is unchanged (7.32 against 7.30). The cost moved into the
  frames that draw a strip: p95 rose by 0.26 ms (3.4%).
- `scroll` no longer has a full-canvas frame; it is better than without
  strips at p95, p99 and max (the `--nostrips` run had a 16.35 ms
  frame, the re-anchor drawn at once).
- Between the two sessions the same configuration moved by up to 0.5 ms
  at p99 (`--nostrips` `scroll-long` 12.00 then 11.56 ms), so the 8.09 ms
  p99 is inside the budget by less than that spread.
- The three dropped frames are one hitch at the start of the scenario
  that the profiler attributes outside the compositor (layout, paint, GC
  or script); the GPU's worst frame in the run was 9.2 ms.

## Evaluation

Hypothesis 1 is supported on p99 and p50 and missed on p95: after the
interval fix, `scroll-long`'s GPU p99 is 8.09 ms (threshold 8.33; 11.56
without strips in the same session) and p50 +0.3% (threshold +5%), but
p95 is 7.94 ms against a 7.8 ms threshold. That threshold was set from
the 2026-10-15 session (7.30 + 7%); this session's own baseline p95 was
7.68 ms, and strips add 3.4% to it. Hypothesis 2 is supported after the
fix (`scroll` p99 7.77 against 8.64 ms). Hypothesis 3 is supported on
Metal (0 / 4 px, as without strips); SwiftShader shows 5 px more with
opacity groups, the same unexplained difference as in the earlier
experiment.

On the question the earlier experiment left: drawing a second, culled
range per frame costs little when the strip is small. The cost tracks
the rows drawn, so sizing strips to the scroll speed (96 CSS px at
`scroll-long`'s 40 px steps, against 337 before) is what took the p95
from +21% to +3.4%.

## Conclusion and next step

Known now: a band-filled canvas can take a re-anchor's new rows over
several frames without exceeding the 120 Hz budget at dpr 2 on an
M1 Pro, if each frame draws only a strip about twice the scroll step,
culled to its rows, and the pending rows are tracked as separate
intervals (a single span across both ends of the canvas covered the
viewport and forced a full redraw). Pending rows must also keep the
loop running and turn scene reuse off, or a still page never finishes
them. `reanchorStrips` stays on by default.

Next:

- The p99 margin (0.24 ms) is smaller than the run-to-run spread. If it
  matters, the strip's minimum (96 CSS px) can come down, or a frame
  could skip its strip when its band alone is already near the budget.
- The SwiftShader-only 5 px where a group crosses a strip edge is still
  unexplained.
- The floor (main pass plus copy, ~7 ms at dpr 2) is now most of every
  frame; that is the larger remaining cost.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
| Strips drawn only on frames already requested | First version | Stopped with rows pending once the scroll settled (210 blank rows in the stall check) and with the post chain on (scene reuse); pending rows now keep the loop and disable reuse | 2026-10-16 |
| Pending rows as one interval | Taken from the 2026-10-15 diff | After re-anchors at both ends the interval spanned the viewport, which drew the whole canvas in one frame (14.5 ms on `scroll`); replaced by separate intervals and the nearest one first | 2026-10-16 |
