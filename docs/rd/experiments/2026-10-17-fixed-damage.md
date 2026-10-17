# Experiment: fixed content as damage instead of a full redraw

| Field | Value |
| --- | --- |
| Activity | C2 (latency vs cost of the document-space canvas) |
| Status | Concluded (supported; re-anchor frames are the tail) |
| Started | 2026-10-17 |
| Concluded | 2026-10-17 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-17-fixed-damage/` |

## Hurdle

`skipUnchanged` (`2026-10-16-skip-unchanged.md`) cut a dpr 2 scroll
frame of `perf.html` on an M1 Pro from ~7.5 ms of GPU time to ~2 ms or
nothing, but it turns itself off on any page with viewport-space
(`position: fixed`) content: every scroll frame then redraws the whole
band again. Sites have fixed navigation bars, so the saving doesn't
reach them.

## Why existing knowledge doesn't resolve it

Fixed content is drawn into the document-space canvas at its position
for the frame's scroll, so it moves against the kept texture on every
scroll step: the rows it covered must be redrawn without it and the rows
it now covers with it. Browser compositors give fixed elements their own
layer instead; here everything shares one kept texture and one main
pass. Whether redrawing only those rows (the element's old and new
rows, as extra scissored draws in the main pass) costs little enough,
and whether the rows can be derived reliably from the scene (records'
rects, text shadows, groups' viewport bounds), isn't known.

## Hypothesis

With `skipUnchanged`, a frame whose content is unchanged but whose
scroll differs from the one fixed content was last drawn at draws the
band rows not yet valid plus the device rows fixed content covers at the
old and at the new scroll (each run of rows under its own scissor,
merged when under 64 rows apart). On the M1 Pro, headed, `perf.html?fixed`
(n = 400, a 64 px fixed bar), `--nodim --dpr 2 --band`:

1. `scroll` and `scroll-long` GPU total p50 over drawn frames at most
   3.5 ms (the band redraw without skipping: ~7.5 ms), no dropped frames.
2. Visual, fx and edit harnesses unchanged; the stall checks with
   `--fixed` differ from `full` by no more than with `--noskip`.

## Why the outcome is uncertain

- Every scroll frame now draws (the bar moves), so no frame is skipped;
  each pays the kept-to-canvas copy (~0.7 ms) plus two or three
  scissored draws of the batch list culled to the band, whose vertex
  work may dominate.
- A footprint that misses part of what fixed content paints (shadow
  extents, transformed fixed elements, glyph overhang) leaves a trail of
  the bar on the page while scrolling; the padding is a guess.
- A tall fixed element (a fixed full-height background) makes the
  damage the whole viewport, which is no better than before.

## Method

1. `gpu/renderer.ts`: `fixedRows` (viewport-y intervals of viewport-space
   boxes, images, cutouts, glyphs with their text-shadow extent, and
   groups' `vbounds`, cached per batch list and version) replaces the
   "has viewport content" test in `contentChanged`; `fixedScrollY` is the
   scroll fixed content was last drawn at; `skipFrame` doesn't skip when
   it differs; the trimmed band becomes a list of row runs (the band rows
   not yet valid, plus the fixed rows at both scrolls), the first drawn
   as the band and the rest as extra scissored draws.
   `test:profile --fixed`, `test:round` `FILL=--fixed`.
2. Run: `FILL=--fixed PROFILE="--only scroll,scroll-long --nodim --dpr 2
   --band --fixed" pnpm test:round docs/rd/evidence/2026-10-17-fixed-damage
   --noskip`.

## Results

| Measure | Baseline | Result | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| `scroll` GPU total p50 / p95 / p99 / max, `perf.html?fixed`, M1 Pro, headed, `--nodim --dpr 2 --band` | 6.76 / 6.83 / 7.04 / 9.34 ms (`--noskip`, same round) | 2.95 / 3.68 / 4.10 / 4.47 ms | p50 at most 3.5 ms | 2026-10-17 | `2026-10-17-m1pro-profile.txt`, `-profile--noskip.txt` |
| `scroll-long` GPU total p50 / p95 / p99 / max, same | 6.97 / 7.56 / 7.67 / 7.71 ms | 3.20 / 4.55 / 8.33 / 9.28 ms | p50 at most 3.5 ms | 2026-10-17 | same |
| Frames skipped, `scroll` / `scroll-long` | 0 / 0 | 0 / 2 | report | 2026-10-17 | same |
| Frames dropped | 0 / 0 | 0 / 0 | 0 | 2026-10-17 | same |
| Stall checks `--fixed`, headed, px differing from `full`, down / up | 0 / 0 (`bandnostrip` and the rest, same run) | 0 / 0; blank rows 26 / 87, as `full` | as before | 2026-10-17 | `2026-10-17-m1pro-fill.txt`, `-fill-up.txt` |
| Visual and fx harnesses (headless, SwiftShader), edit harness (headed) | goldens / rebuild | OK / OK / 0 px | no change | 2026-10-17 | `2026-10-17-m1pro-visual.txt`, `-fx.txt`, `-edit.txt` |

Observations:

- As expected, almost no frame is skipped with a fixed bar (it moves
  against the canvas every scroll step), but each costs about 3 ms
  instead of 6.8-7.0: the copy plus the bar's old and new rows and the
  band's leading edge.
- `scroll-long`'s p99 and max (8.33 / 9.28 ms) are higher than without
  skipping in this round (7.67 / 7.71), and above the 120 Hz budget.
  They are the re-anchor frames: the shift, a strip of pending rows, the
  bar's rows and the leading edge, each a scissored draw of the batch
  list (four draws), against one band draw without skipping. No frame
  dropped (single long frames are absorbed, `2026-10-16-gpu-headroom.md`).
  Without a fixed bar (`2026-10-16-skip-unchanged.md`) those frames cost
  6.6-6.9 ms; between rounds `--noskip`'s own p99 has ranged from 7.7 to
  13.0 ms, so the comparison is within one round only.
- No trail of the bar in any check: the stall checks match `full` with
  `--fixed`, and the visual harness has a fixed section.

## Evaluation

Supported on its thresholds: with a 64 px fixed bar, scroll frames cost
2.95-3.20 ms of GPU time at p50 (threshold 3.5; 6.76-6.97 ms redrawing
the band in the same round), no frames dropped, and the harnesses and
stall checks are unchanged. The re-anchor frames of `scroll-long` got
slower than without skipping (p99 8.33 against 7.67 ms) because they now
issue up to four scissored draws.

## Conclusion and next step

Known now: fixed content can be handled as damage, its rows at the old
and new scroll, instead of turning the kept-texture reuse off; a page
with a fixed header then scrolls at well under half the GPU cost.

Next: a re-anchor frame with fixed content draws the batch list up to
four times; merging the runs into one draw when their total height is
close to the band's (or skipping the separate leading-edge draw on
those frames) would keep its tail at or below the band redraw.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
