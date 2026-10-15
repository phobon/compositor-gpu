# Experiment: spreading a re-anchor's new rows over several frames

| Field | Value |
| --- | --- |
| Activity | C2 (latency vs cost of the document-space canvas, hypothesis 1) |
| Status | Concluded (not supported; reverted) |
| Started | 2026-10-15 |
| Concluded | 2026-10-15 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-15-reanchor-spread/` |

## Hurdle

With `canvasFill: 'band'` (the default), the canvas keeps its pixels
between frames and redraws only the band around the viewport. When the
viewport reaches the canvas's edge, the canvas re-anchors: the kept
pixels shift by a texture copy and the rows it newly covers (about a
viewport) are drawn in that same frame together with the band, about
two thirds of the canvas. On an M1 Pro at dpr 2 that puts
`scroll-long`'s GPU p99 at 10.35 ms against an 8.33 ms budget
(`2026-10-14-band-margins.md`), once per viewport scrolled.

## Why existing knowledge doesn't resolve it

Browser compositors raster new tiles over several frames, prioritised
by distance from the viewport, but they own the tiling. Here the canvas
is one texture and a frame's main pass has one scissor: drawing the band
and a separate strip in the same frame means drawing the batch list
twice under two scissors, with opacity groups, culling and the kept
texture's clear all assuming one region. Whether the strips' extra
vertex work and the second scissor cost less than drawing the rows at
once, and how far ahead of the viewport the new rows stay valid while
they are filled in, isn't known in advance.

## Hypothesis

Clearing the newly covered rows on the re-anchor frame and drawing them
in strips of an eighth of the canvas per frame (nearest the viewport
first), each as a second scissored draw of the batch list in the main
pass, brings `scroll-long`'s GPU p99 at dpr 2 with the band on the M1 Pro
to at most 8.33 ms, with the p50 at most 10% higher and the stall checks
still matching `full`.

## Why the outcome is uncertain

- The second draw of the batch list repeats vertex and binning work for
  every frame a strip is pending; on a tiled GPU that may cost as much as
  drawing the rows at once.
- While strips are pending, a stalled main thread could reveal cleared
  rows; `scroll-long` scrolls 40 px per frame and the strips have to
  stay ahead of it.
- Backdrops end and restart the main pass; pages with them keep drawing
  the rows at once.

## Method

1. `gpu/renderer.ts`: `keepMargins`' newly covered rows become pending
   rows (shifted with the texture on later re-anchors), cleared on the
   re-anchor frame; each frame draws the band, then up to a strip of
   pending rows next to it as a second `drawRange` under that scissor
   (groups are prepared for both regions; culling uses the canvas while
   rows are pending). With backdrops in the scene, the old behaviour.
2. Measures: `test:profile --headed --only scroll,scroll-long --nodim
   --dpr 2 --band` on the M1 Pro, before (stash) and after; the stall
   checks (`test/fill/run.ts`, all variants) in SwiftShader and headed.

## Results

| Measure | Before | After | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| Stall check px differing from `full`, SwiftShader: down / up / fixed up / blur | 0 / 40 / 40 / 0 | 5 / 49 / 49 / 5 | match full | 2026-10-15 | `2026-10-15-swiftshader.txt` |
| Blank rows in the same checks (band vs full) | equal | equal (34, 39, 88, 33) | no more than full | 2026-10-15 | same |
| Same, `--nodim` (no groups) | 0 px | 0 px | match full | 2026-10-15 | same |
| GPU p50 / p95 / p99 / max, M1 Pro, `scroll-long --nodim --dpr 2 --band` | 6.41 / 7.30 / 11.19 / 11.31 ms | 6.53 / 8.81 / 9.12 / 9.31 ms | p99 at most 8.33 ms, p50 at most +10% | 2026-10-15 | `2026-10-15-m1pro.txt` |
| Same, `scroll` | 6.43 / 7.16 / 8.49 / 10.34 ms | 6.40 / 6.64 / 8.24 / 11.95 ms | - | 2026-10-15 | same |
| Stall check headed, M1 Pro (down) | 0 px | 0 px | match full | 2026-10-15 | same |

Observations so far:

- The strips work as designed: after a re-anchor the newly covered rows
  are cleared and filled over three frames at dpr 1, and no viewport
  rows are left blank in any stall check.
- A small new difference from `full` appears where an opacity group
  (a dimmed card) crosses the lower edge of a re-anchor's first strip:
  5-9 px at up to 11/255, slight shifts at text edges inside the card,
  drawn in the first strip's frame. It disappears when the strip covers
  the whole card, with no groups, or with the pending rows drawn at once;
  it persists with the group atlas off. Cause not identified; small
  enough not to block the measurement, but open.

- On the M1 Pro the worst frames of `scroll-long` came down (p99 11.19
  to 9.12 ms, max 11.31 to 9.31 ms) but not under the 8.33 ms budget,
  and the cost moved into more frames: p95 rose from 7.30 to 8.81 ms,
  over budget. Each strip frame draws the batch list twice; the second
  draw's vertex and binning work for the whole canvas region is paid on
  every strip frame, so three cheaper frames cost more in total than one
  expensive one. No frames dropped in either run.
- The stall check headed on Metal matched `full` exactly; the small
  difference seen in SwiftShader where a group crosses a strip edge
  didn't appear there.

## Evaluation

Not supported. Strips lowered the p99 by 18% but left it over budget
and raised the p95 by 21%, so more frames than before exceed 8.33 ms;
with no dropped frames either way, that is a worse frame-time
distribution, not a better one. The change is reverted; the code tried
is kept in the evidence folder.

## Conclusion and next step

Known now: on a tiled GPU, drawing the batch list a second time under
another scissor costs close to a full draw's geometry work, so
spreading fill over frames doesn't pay unless the strip's draw is culled
to the strip (the strips here culled to the whole canvas). If the
re-anchor tail matters later: cull the strip's draw to its rows, or
re-anchor in smaller steps so each frame's new rows stay small.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
| Strips of an eighth of the canvas per frame, second scissored draw culled to the canvas | Spread the re-anchor's fill | p99 -18% but p95 +21% on the M1 Pro; reverted | 2026-10-15 |
