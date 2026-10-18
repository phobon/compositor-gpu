# Experiment: culling the partial redraws to their own rows

| Field | Value |
| --- | --- |
| Activity | C2 (latency vs cost of the document-space canvas) |
| Status | Concluded (partly supported: p50 and CPU met, p99 not) |
| Started | 2026-10-17 |
| Concluded | 2026-10-17 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-17-row-culling/` |

## Hurdle

With `skipUnchanged` and fixed content handled as damage
(`2026-10-17-fixed-damage.md`), a re-anchor frame of `scroll-long` on
`perf.html?fixed` issues up to four scissored draws of the batch list
(the band's leading edge, the fixed bar's old and new rows, a strip of
newly covered rows). Its GPU p99 / max on an M1 Pro at dpr 2 rose to
8.33 / 9.28 ms, above the band redraw it replaced (7.67 / 7.71 ms in the
same round) and at the 120 Hz budget.

## Why existing knowledge doesn't resolve it

Strips are culled to their own rows; the leading edge and the fixed
rows are culled to the whole band (~3 viewports of instances with its
half-canvas margin), so each of those draws repeats the band's vertex
and binning work for a few dozen rows of pixels. Merging the runs into
one scissor instead would redraw the rows between them (a viewport at
~2.5 µs per device row, more than the draws cost). Whether culling each
run to its rows removes enough of the per-draw cost, and whether the
extra culling CPU stays small, isn't measured.

## Hypothesis

Culling the trimmed band's draw and each extra draw to their own rows
(snapped to 128 CSS px tiles and cached per batch list, so successive
frames reuse them) brings `scroll-long --fixed` GPU p99 at dpr 2 on the
M1 Pro to at most 7.5 ms and its p50 to at most the 3.20 ms measured
before, with compositor CPU p95 no more than 0.3 ms higher and the
harnesses and stall checks unchanged.

## Why the outcome is uncertain

- The draws' fixed cost (pipeline and bind-group changes per batch,
  ~100 draw calls each) may dominate their instance count.
- Each new tile span costs a cull query on the CPU; while scrolling the
  leading edge crosses a tile every few frames.
- The re-anchor frame's cost may be mostly the texture shift and the
  copy, which culling doesn't touch.

## Method

1. `gpu/renderer.ts`: `rowRuns` (runs culled to a row span snapped out
   to 128 CSS px, cached per batch list, up to 16 spans, cleared with the
   other cull caches when records move); used for the trimmed band and
   the extra draws.
2. Run: `FILL=--fixed PROFILE="--only scroll,scroll-long --nodim --dpr 2
   --band --fixed" pnpm test:round docs/rd/evidence/2026-10-17-row-culling
   --noskip`, compared with the fixed-damage round.

## Results

| Measure | Baseline | Result | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| `scroll-long --fixed` GPU total p50 / p95 / p99 / max, M1 Pro, headed, `--nodim --dpr 2 --band` | 3.20 / 4.55 / 8.33 / 9.28 ms (band-culled draws, fixed-damage round) | 3.11 / 4.54 / 7.95 / 8.71 ms | p99 at most 7.5, p50 at most 3.20 | 2026-10-17 | `2026-10-17-m1pro-profile.txt` |
| `scroll --fixed`, same | 2.95 / 3.68 / 4.10 / 4.47 ms | 2.75 / 3.23 / 3.32 / 3.40 ms | report | 2026-10-17 | same |
| `--noskip` in this round, `scroll` / `scroll-long` p50 / p99 | - | 6.93 / 7.31, 6.92 / 7.59 ms | report | 2026-10-17 | `2026-10-17-m1pro-profile--noskip.txt` |
| Compositor CPU p95, `scroll` / `scroll-long` | 0.30 / 0.50 ms | 0.40 / 0.40 ms | at most +0.3 ms | 2026-10-17 | `2026-10-17-m1pro-profile.txt` |
| Frames dropped | 0 / 0 | 0 / 0 | 0 | 2026-10-17 | same |
| Stall checks `--fixed` (down / up), visual, fx, edit | 0 / 0 px, OK, OK, 0 px | 0 / 0 px, OK, OK, 0 px | unchanged | 2026-10-17 | `2026-10-17-m1pro-round.txt` |

Observations:

- Culling the partial draws to their rows took 0.2 ms off a typical
  frame and 0.4-0.8 ms off the tails (`scroll` p99 4.10 to 3.32 ms,
  `scroll-long` 8.33 to 7.95 ms). The re-anchor frames of `scroll-long`
  remain at 7.6-8.7 ms: their main pass is still 6.9-8.1 ms at p99 /
  max, so most of what they cost is not the draws' instance count but
  the strip's rows, the shifted texture and the full copy (the copy
  span reaches 7.6-7.9 ms there; spans overlap, so it isn't separable
  from the main pass with these timings).
- One `scroll` frame had 5.7 ms of compositor CPU (p99 0.8 ms); likely a
  first cull query into a new tile span before the y index was built.
- In this round's `--noskip` run the band redraw's p99 was 7.59 ms, so
  `scroll-long`'s worst frames with skipping are still ~0.4 ms slower
  than redrawing the band every frame, but they are now the only frames
  near the budget; the rest cost less than half.

## Evaluation

Partly supported: p50 (3.11 ms, threshold 3.20) and CPU (p95 +0.0-0.1
ms) are met and the tails came down, but `scroll-long`'s GPU p99 is
7.95 ms against a 7.5 ms threshold. The change is kept: every measure
improved or held.

## Conclusion and next step

Known now: the partial draws' cost was partly their culling (0.2-0.8 ms
recovered), but a re-anchor frame with fixed content is dominated by
fill and the copy, not by the number of draws or their instances.

Next, if the re-anchor tail matters: time a re-anchor frame's parts
separately (the shift copy, the strip, the kept-to-canvas copy) with a
profiler mark on re-anchor frames, then size the first strip after a
re-anchor smaller or defer it a frame when fixed damage is drawn in the
same frame.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
| Merging the runs into one scissor | Fewer draws | Not tried: the rows between the fixed bar and the leading edge are about a viewport, costing more fill than the draws saved | 2026-10-17 |
