# Experiment: segment outline morphs between strings, in budget

| Field | Value |
| --- | --- |
| Activity | X (to confirm: the GPU polygon fill and the segment correspondence may belong under C3; the look itself is X) |
| Status | Concluded |
| Started | 2026-10-26 |
| Concluded | 2026-10-26 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | none yet (`playground/spike_morph.*`, uncommitted) |
| Evidence folder | `docs/rd/evidence/2026-10-26-segment-morph/` |

## Hurdle

The reference (two screen recordings from Ben, 2026-10-26) changes one
string into another (83 -> S15_ -> 32* -> 5/6) by cutting the glyphs into
segments of stroke whose outlines morph into the next string's segments,
under a separate post effect: a bulge at the centre that expands as a
ring, with zoom blur and a red/blue fringe. The compositor draws glyphs
with Slug, whose precomputed bands assume a fixed outline, so there is no
outline to interpolate per frame. The morph has to start and end on the
exact mirrored text and fit the M5 budget: gpu total p95 at most 1.5 ms
above the same page with the loop running, 0 dropped frames at 120 Hz,
on an M1 Pro at dpr 2.

## Why existing knowledge doesn't resolve it

SVG morph tools (flubber, GSAP MorphSVG) interpolate resampled paths on
the CPU and let the browser rasterise them each frame: one path at a
time, no glyph cutting, and not inside this canvas. Shatter and dissolve
effects (including this library's `dissolve`) cross-fade or fly pieces
of a fixed shape; the outline doesn't change. Slug (Lengyel) renders
static outlines from bands; re-banding per frame on the CPU or in a
compute pass was not tried. Nothing found cuts two strings into
corresponding segments.

## Hypothesis

If each glyph is cut into compact segments (k-means of its ink, straight
cuts between centroids), the two strings' segments are paired by least
travel, each pair's outlines are resampled to M points with aligned
starts, and the pair is drawn as one instanced quad whose fragment fills
the interpolated polygon by brute-force winding (no bands), then the
morph reads like the reference and costs under 1.5 ms of gpu total p95,
because a segment has few edges and covers a small area.

## Why the outcome is uncertain

The per-pixel cost is M edges times the blur samples, over the union of
the pieces' quads; whether that fits next to a 7 ms band frame at dpr 2
was unknown. Whether segments cut by k-means read as strokes, and
whether a point-to-point morph between unrelated segments looks like the
reference rather than a smear, could only be judged by eye.

## Method

1. Throwaway page `playground/spike_morph.html` / `.ts` on `fx.layer`
   with `glyphs:` (no `src/` changes). Iterations, each judged by Ben
   against the reference:
   - Voronoi shards per glyph flying out and in, with per-piece analytic
     motion blur: rejected, pieces cross-fade instead of re-forming.
   - Rigid k-means segments paired one to one, content switched mid-flight:
     segments snapped between states.
   - Distance-field blend inside each segment (Slug's ray coverage with a
     wide ramp): the outline melts, no sharp branch like the reference.
   - Polygon outlines (marching squares on the segment's field, largest
     loop, resampled to 64 points, start aligned), filled by winding with
     exact edge-distance anti-aliasing: matches the reference.
   - Blur and fringe moved from the pieces to a fullscreen pass: a ring
     from the text's centre, expanding at a set speed and fading, carrying
     magnification, zoom blur, radial split and a fixed-width fringe.
2. `__spike.sweep()` on `spike_morph.html?rows=6&size=96` (6 stages, about
   18 glyphs per string), M1 Pro, headed, dpr 2: 3 s per config, morph
   cycling with no hold.
3. Thresholds: as the hurdle.

## Results

| Measure | Baseline | Result | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| gpu total p95, morph 8/16/32 pieces, first polygon cut | 3.28 ms (plain page, earlier run) | 8.0-9.8 ms, 10-58 dropped | +1.5 ms, 0 dropped | 2026-10-26 | `2026-10-26-sweep-2-unoptimised.json` |
| gpu total p95, morph 8/16/32 pieces, optimised | 4.19 ms (loop running, nothing drawn) | 4.26-4.39 ms (+0.07-0.20), 0/0/3 dropped | +1.5 ms | 2026-10-26 | `2026-10-26-sweep-3-optimised.json` |
| gpu total p95, morph 16 + wave, 1-16 taps, optimised | 4.19 ms | 4.65-4.85 ms (+0.46-0.66), at most 1 dropped | +1.5 ms | 2026-10-26 | `2026-10-26-sweep-3-optimised.json` |
| gpu total p50, same | 1.90 ms | 2.10-2.29 (morph), 2.88-3.08 (+ wave) | | 2026-10-26 | same |

Observations:

- The first polygon cut built both 64-point outlines in function-scope
  arrays in every fragment (likely spilled), used square quads around the
  farthest point, drew Slug chunks for pieces at rest, and ran the wave
  on every pixel. Reading points edge by edge through one 2x2 map per
  side, tight quads, drawing pieces only while a morph runs, and skipping
  pixels off the ring cut the morph from about +5 ms to +0.2 ms.
- Fewer pieces cost more before the fix: cost follows quad area, not
  piece count.
- An active extra layer turns scene reuse off, so the loop with nothing
  drawn already costs 1.9 ms p50 at dpr 2; a still page skips frames
  entirely.
- GPU timestamps came back in ~0.1 ms steps (three identical p50s).
- An exception in a layer's `update` stops the compositor's frame loop
  (no catch around hooks); the first sweep died that way.

## Evaluation

Supported, after the optimisations: a 16-segment morph with the wave
pass stays within 0.7 ms of the running-loop baseline at p95 with no
dropped frames. The look was accepted by Ben by eye against the
reference. Not measured: larger type (cost follows piece area), many
morphs at once, Safari.

## Conclusion and next step

Text changes in M5 morph segment outlines point to point, drawn by the
path pass (planned for SVG, Q8) rather than as fragments; the blur and
fringe are a separate post preset. Next: the path pass in `src/` with
segment outlines cut from the font outline (not a raster), then the
ghost-record morph engine (`2026-10-26-morph-ghosts.md`).

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
| Voronoi shards with exit/enter and per-piece analytic blur | First reading of the reference | Read as a cross-fade; rejected by Ben | 2026-10-26 |
| Rigid matched segments, content switched mid-flight | Pieces should re-form, not fade | Segments snapped between states | 2026-10-26 |
| Distance-field blend within segments | Continuous outline change from Slug coverage | Melted shapes, no sharp branches | 2026-10-26 |
| Per-piece blur and fringe | Velocity known analytically | The reference's blur is a frame-wide ring; moved to a post pass | 2026-10-26 |
