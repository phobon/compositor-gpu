# Experiment: drawing only the rows that changed on scroll frames

| Field | Value |
| --- | --- |
| Activity | C2 (latency vs cost of the document-space canvas) |
| Status | Concluded (supported) |
| Started | 2026-10-16 |
| Concluded | 2026-10-16 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-16-skip-unchanged/` |

## Hurdle

A band-filled scroll frame of `perf.html` occupies an M1 Pro's GPU for
~7 ms at dpr 2, of an 8.33 ms budget at 120 Hz, and frames drop with
~1.7 ms more work (`2026-10-16-gpu-headroom.md`). Almost all of it is
the main pass redrawing the viewport and its band (~1156 CSS rows at
~5 µs a row) plus the copy of the kept texture to the canvas. On a page
whose content didn't change, that redraw reproduces pixels the kept
texture already holds: records are in document space and the canvas
moves with the page.

## Why existing knowledge doesn't resolve it

Browser compositors avoid re-rastering on scroll by keeping tiles and
tracking damage, but they own the tiling and the invalidation. Here the
canvas has one kept texture, content changes reach the renderer only as
a new scene version, dirty layers or a new batch list, and several
things draw differently on every frame without any of those changing:
viewport-space (fixed) records move against the canvas, `/fx` layers,
regions, layer transforms and materials may animate, dynamic images
upload every frame. Whether a conservative "nothing changed" test
catches all of them on the sites' pages, and what a frame that draws
nothing costs (the copy still runs when anything is drawn; a skipped
frame calls no `getCurrentTexture` at all and the canvas keeps what it
last presented), isn't known.

## Hypothesis

With `skipUnchanged` (default on): the renderer keeps the device rows of
the kept texture drawn since the content last changed (`valid`, shifted
with the texture on a re-anchor). A frame whose content is unchanged
draws only the band rows not in `valid` (plus re-anchor strips), and a
frame with nothing to draw is skipped (no command buffer). Any change
(dirty layer, scene version, batch list, material pipelines settling)
or any per-frame content (viewport-space records, active extra layers,
regions, layer transforms or `/fx` materials, backdrops) empties `valid`
and keeps the current behaviour.

On the M1 Pro, headed, `perf.html` n = 400, `--nodim --dpr 2 --band`:

1. `scroll` and `scroll-long`: GPU total p50 over the frames still drawn
   at most 3 ms (6.9-7.6 ms without), and at least half the frames
   skipped on `scroll`.
2. No frames dropped, and frame interval p95 no higher than without.
3. Visual, fx, edit and stall checks unchanged (the stall checks
   compare kept pixels, which skipping must not change).

## Why the outcome is uncertain

- A frame that draws anything still copies the whole kept texture
  (~3 viewports at dpr 2) to the canvas; if the copy is most of a
  frame's cost, drawn frames stay expensive.
- The leading-edge rows a scroll frame needs are thin (a scroll step),
  but the draw is still culled to the whole band; vertex work may
  dominate such a frame.
- A missed per-frame source (something that changes pixels without a
  version, dirty layer or batch change) would leave stale pixels on
  screen; the harnesses only catch the ones they exercise.
- Whether Chrome keeps presenting the last canvas image unchanged
  across frames with no `getCurrentTexture` call, in every compositing
  mode, isn't documented for all cases.

## Method

1. `gpu/renderer.ts`: `noteScroll` split out of `fillBand` (the scroll
   history is kept on skipped frames); `contentChanged` (the
   conservative test above); `valid` row intervals, emptied on a change
   or a full redraw, shifted in `keepMargins`, grown by the rows each
   frame draws; band rows already valid are not drawn; `skipFrame`
   returns before `getCurrentTexture` when the canvas didn't move, no
   rows are pending and the band is valid. `CompositorOptions
   .skipUnchanged` (default true), `perf.html?noskip`, `test:profile
   --noskip`; `stats().skippedFrames`; the profiler marks skipped frames
   and the report prints how many frames were drawn.
2. Checks: `pnpm test:round docs/rd/evidence/2026-10-16-skip-unchanged
   --noskip` on the M1 Pro (visual, fx, edit, stall checks, profile with
   and without).

## Results

| Measure | Baseline | Result | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| `scroll` frames skipped, M1 Pro, headed, `--nodim --dpr 2 --band` | 0 of 259 (`--noskip`, same round) | 120 of 239 | at least half | 2026-10-16 | `2026-10-16-m1pro-profile.txt`, `-profile--noskip.txt` |
| `scroll` GPU total p50 / p95 / p99 / max over drawn frames | 7.60 / 11.61 / 12.67 / 12.91 ms | 1.98 / 2.69 / 4.31 / 6.89 ms | p50 at most 3 ms | 2026-10-16 | same |
| `scroll-long` frames skipped | 0 of 259 | 151 of 242 | report | 2026-10-16 | same |
| `scroll-long` GPU total p50 / p95 / p99 / max over drawn frames | 7.50 / 10.60 / 13.02 / 13.61 ms | 2.12 / 6.65 / 6.91 / 6.91 ms | p50 at most 3 ms | 2026-10-16 | same |
| Frames dropped, `scroll` / `scroll-long` | 0 / 0 | 0 / 0 | 0 | 2026-10-16 | same |
| Frame interval p95, `scroll` / `scroll-long` | 9.20 / 9.20 ms | 9.30 / 9.20 ms | no higher | 2026-10-16 | same |
| Visual harness (on the M1 Pro, but headless: SwiftShader) | goldens | OK | no change | 2026-10-16 | `2026-10-16-m1pro-visual.txt` |
| fx harness (same) | goldens | OK | no change | 2026-10-16 | `2026-10-16-m1pro-fx.txt` |
| Edit harness, headed | - | 19 of 21 reads patched, 0 px between patched and rebuilt canvases | 0 px | 2026-10-16 | `2026-10-16-m1pro-edit.txt` |
| Stall checks headed, px differing from `full`, down / up | - | 0 / 0; blank rows 26 / 39, as `full` | as before | 2026-10-16 | `2026-10-16-m1pro-fill.txt`, `-fill-up.txt` |

Observations:

- Half of `scroll`'s frames and 62% of `scroll-long`'s drew nothing. The
  frames that drew cost about 2 ms at p50: the copy of the kept texture
  (~0.6-0.7 ms) and a main pass that draws only the rows not yet valid
  (0.4-1.0 ms; its draws are still culled to the whole band, so the
  vertex work stays).
- `scroll-long`'s p95-max (6.6-6.9 ms) are the re-anchor frames and
  their strips (a shifted texture, newly covered rows, the full copy):
  about half what they cost redrawing the band (13.0-13.6 ms at p99 and
  max without skipping in the same round).
- The frame interval p95 differs by 0.1 ms on `scroll` (9.30 against
  9.20), within the profiler's resolution; no frame was late.
- The stall checks now differ from `full` by 0 px in both directions
  (4 px upward in earlier sessions with redrawing): the kept pixels are
  the same, and the last frame before the stall drew 4 rows.
- The visual and fx harnesses run headless and fell back to SwiftShader
  on the Mac as well; they are regression checks against goldens made
  the same way.

## Evaluation

Supported. On the M1 Pro at dpr 2, 50-62% of scroll frames over
`perf.html` drew nothing, the frames that drew cost 1.98-2.12 ms of GPU
time at p50 (threshold 3 ms; 7.50-7.60 ms redrawing the band in the same
round), the worst frames halved (p99 4.3 / 6.9 against 12.7 / 13.0 ms),
no frames dropped, and the visual, fx, edit and stall checks are
unchanged.

## Conclusion and next step

Known now: the band's per-frame redraw was what the dpr 2 floor was
made of. With the kept texture tracked as valid rows and a conservative
content-change test, a scroll over unchanging content costs a copy and
the rows not yet drawn, or nothing; the GPU headroom at 120 Hz goes from
about 1 ms to about 6 ms on drawn frames.

Next, if drawn frames matter:

- A drawn frame still copies the whole kept texture (~3 viewports at
  dpr 2) to the canvas; copying only the rows that changed needs the
  canvas texture's previous contents, which a swap-chain texture
  doesn't keep.
- The thin rows a scroll step needs are drawn with draws culled to the
  whole band; culling them to the rows (as strips are) would cut the
  vertex work of those frames.
- Pages with fixed content, `/fx` layers or materials still redraw the
  band every frame; fixed records could be handled as damage (their old
  and new rects) instead of turning skipping off.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
