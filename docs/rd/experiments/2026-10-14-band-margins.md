# Experiment: keeping the margins' last contents in band mode

| Field | Value |
| --- | --- |
| Activity | C2 (latency vs cost of the document-space canvas, hypothesis 1) |
| Status | Concluded (supported on the M1 Pro; stall check in SwiftShader only) |
| Started | 2026-10-14 |
| Concluded | 2026-10-14 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-14-band-margins/` |

## Hurdle

At dpr 2 on an M1 Pro the full canvas costs 14.1 ms of main pass per
frame on `perf.html` and drops 170 of 251 frames at 120 Hz; drawing only
the band cuts that 53% with no dropped frames
(`2026-10-14-band-culling.md`). The band can't be the default because
the canvas outside it is cleared every frame: if the main thread stalls
while the page scrolls, the browser's compositor scrolls blank canvas
into view (482 of 900 viewport rows after a 600 px scroll, against 30
with `full`; `2026-10-14-fill-cost.md`).

## Why existing knowledge doesn't resolve it

A WebGPU canvas texture doesn't keep its contents between frames
(`getCurrentTexture()` gives a new texture each frame, and WebGPU has no
`preserveDrawingBuffer`), so keeping old pixels means drawing into a
texture of our own and copying it to the canvas, at the cost of a
full-canvas copy every frame. Whether that copy eats the band's saving
on a tiled GPU, where the band's cost was already dominated by
whole-target work, isn't something the documentation answers. Browser
compositors keep tiles between frames for the same reason, but they
own the presentation surface; a page can't.

## Hypothesis

With `canvasFill: 'band'`, drawing the band into a persistent texture
(cleared and redrawn only inside the band, shifted by a texture copy
when the canvas re-anchors, the newly exposed rows drawn in that frame)
and copying it to the canvas each frame:

1. leaves no more blank viewport rows after a 600 px stalled scroll than
   `full` does (stall check: 30 of 900 with `full`);
2. costs at most 60% of `full`'s GPU time per frame at dpr 2 on the M1
   Pro (main pass plus the copy, p50, `perf.html --nodim`, `scroll` and
   `scroll-long`), with no more than 1% of frames dropped.

## Why the outcome is uncertain

- The copy reads and writes the whole canvas every frame. On a tiled GPU
  that is the kind of whole-target work the band couldn't remove; it
  may cost as much as the drawing it saves.
- A re-anchor (about every viewport of scrolling) has to draw the rows
  the canvas newly covers, about two thirds of the canvas in one frame,
  which at dpr 2 may exceed the frame budget on its own.
- Kept margins are stale by design: rows outside the band show what was
  last drawn there. Fixed (viewport-space) elements drawn into rows that
  later leave the band stay there, so a stall could show an old copy of
  a fixed header. How visible that is on the sites is unknown.

## Method

1. `canvasFill: 'band'` keeps the margins (this experiment);
   `canvasFill: 'band-clear'` keeps the fill-cost behaviour for the A/B
   (`perf.html?bandclear`, `test:profile --bandclear`). Not with a post
   chain active (the chain already draws through its own scene texture);
   then `'band'` behaves as `'band-clear'`.
2. Stall check (`test/fill/run.ts`): full, band, band-clear.
3. Profile on the M1 Pro, headed, `--only scroll,scroll-long --nodim` at
   `--dpr 1` and `--dpr 2`: full, `--band`, `--bandclear`. The copy is
   its own timed pass (`copy`), so the GPU total includes it.
4. Visual and fx harnesses with `band` as the default: no new failures
   beyond `fx-blur-scissor`'s known one.

## Results

| Measure | full | band-clear | band (kept margins) | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- | --- |
| Blank viewport rows after a 600 px stalled scroll (stall check, 600 px steps to 3000 px) | 321 of 900 | 482 of 900 | 321 of 900 | no more than full | 2026-10-14 | `2026-10-14-swiftshader.txt` |
| Pixels differing from full in the stall screenshot | - | 176527 | 40 | - | 2026-10-14 | same |
| Visual harness failures with the mode as default (SwiftShader) | 5 | - | the same 5, same numbers | no new failures | 2026-10-14 | same |
| fx harness failures with the mode as default (SwiftShader) | fx-trail*, fx-displace*, fx-dissolve | - | the same, plus fx-blur-scissor | only fx-blur-scissor | 2026-10-14 | same |
| Copy pass vs main pass GPU p50, SwiftShader (`scroll --nodim`, 12 frames) | - | main 2529 ms | main 2684 ms, copy 47 ms | - | 2026-10-14 | same |
| GPU total p50, M1 Pro, dpr 2, `scroll` | 14.14 ms | 5.97 ms | 7.06 ms (50%) | at most 60% of full | 2026-10-14 | `2026-10-14-m1pro-profile.txt` |
| GPU total p50, M1 Pro, dpr 2, `scroll-long` | 14.25 ms | 5.93 ms | 6.36 ms (45%) | at most 60% of full | 2026-10-14 | same |
| Dropped frames at 120 Hz, M1 Pro, dpr 2 (`scroll` / `scroll-long`) | 172 of 251 / 173 of 251 | 0 / 0 | 0 / 0 | at most 1% | 2026-10-14 | same |
| GPU total p99, M1 Pro, dpr 2 (`scroll` / `scroll-long`) | 15.95 / 14.77 ms | 6.66 / 7.41 ms | 7.30 / 10.35 ms | report | 2026-10-14 | same |
| Copy pass alone p50, M1 Pro, dpr 2 / dpr 1 | - | - | 0.46 / 0.14-0.18 ms | report | 2026-10-14 | same |
| GPU total p50, M1 Pro, dpr 1 (`scroll` / `scroll-long`) | 5.15 / 5.48 ms | 3.91 / 3.83 ms | 4.19 / 4.01 ms (81% / 73%) | report | 2026-10-14 | same |
| Encode CPU max, M1 Pro, `scroll` dpr 2 / dpr 1 | 0.20 / 0.30 ms | 4.00 / 3.80 ms | 5.10 / 7.10 ms | report | 2026-10-14 | same |

Observations so far:

- The stall check now scrolls to 3000 px in 600 px steps, so the canvas
  re-anchors on the way and the kept pixels are shifted. That changes
  the `full` result from the fill-cost experiment (30 rows) to 321: the
  last re-anchor leaves the canvas ending 300 px short of the stalled
  viewport, so those rows are blank in every mode. That is the canvas
  margin's own limit, not the band's.
- With kept margins, the stall shows the same picture as `full` (40
  pixels differ, on a tilted card), against half the viewport blank
  with `band-clear`.
- With a post chain running (`fx-blur-scissor`, the trail), `band`
  falls back to `band-clear`; that test's known failure stays. The
  other fx failures happen with `full` too in this container.
- In software rendering the copy costs 2% of the main pass.
- On the M1 Pro at dpr 2, keeping the margins costs 0.4-1.1 ms per frame
  over `band-clear` (p50), and the copy runs alone for 0.46 ms; the rest
  of its span overlaps the main pass. The whole frame stays at about
  half of `full` and no frame is dropped, against two thirds dropped
  with `full`.
- `scroll-long`'s p99 with kept margins (10.35 ms at dpr 2) is above the
  8.33 ms budget without dropping frames; it is most likely the
  re-anchor frames, which draw the newly covered rows (about two thirds
  of the canvas) in one frame. The scenario re-anchors several times.
- At dpr 1 the saving is smaller (19-27% against `full`), as in the
  fill-cost experiment; `full` already fits the frame there.
- The encode CPU spikes (up to 7.1 ms) in band modes are the cull
  recompute from `2026-10-14-cull-recompute.md`, made more frequent
  because a re-anchor frame culls to the canvas instead of the band.

## Evaluation

Supported. Kept margins remove the band's blank-on-stall (the stall
check matches `full`, in SwiftShader) and cost 45-50% of `full`'s GPU
time per frame at dpr 2 on the M1 Pro, with no dropped frames against
68-69% dropped with `full`. The copy is cheap on this GPU (under 0.5 ms
alone at dpr 2), so the earlier worry that whole-target work would eat
the saving didn't hold here.

## Conclusion and next step

Known now: on Apple silicon at Retina density, a document-space canvas
with margins can hold 120 Hz on a 400-card page only if the margins
aren't redrawn every frame, and keeping them in a texture of our own is
enough to make that safe against main-thread stalls.

Next:

1. Decide whether `'band'` becomes the default. Open points: the stall
   check hasn't run on real hardware; with a post chain running
   (phobon.io's trail and lens) `'band'` falls back to clearing; and a
   fixed element drawn into kept rows can show as an old copy during a
   stall (not seen on perf.html, which has none).
2. Spread a re-anchor's newly covered rows over a few frames, to bring
   the p99 under budget.
3. The cull recompute spike (`2026-10-14-cull-recompute.md`), now also
   on re-anchor frames.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
| Smaller `canvasMargin` at high dpr | Less to fill every frame without a new texture | Not tried: shrinks how far a stall can scroll before blank, the opposite of the goal | 2026-10-14 |
| Ring-buffer texture (rows addressed modulo height, re-anchoring every frame) | No shift copy, full margins always | Not tried: draws that wrap need two passes and two copies; the shift copy is simpler and only runs on re-anchor | 2026-10-14 |
