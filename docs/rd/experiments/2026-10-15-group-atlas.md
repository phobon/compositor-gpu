# Experiment: one pass for a frame's opacity groups

| Field | Value |
| --- | --- |
| Activity | C2 (low-latency DOM-to-GPU synchronisation at pixel parity; opacity groups) |
| Status | Concluded (supported, but the effect on the frame is within run-to-run spread) |
| Started | 2026-10-15 |
| Concluded | 2026-10-15 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-15-group-atlas/` |

## Hurdle

Every opacity group (an element with opacity < 1, a colour filter, an
isolated context) renders into its own pooled texture in its own render
pass, then composites once. On an M1 Pro the groups on `perf.html` (every
seventh card dimmed, ~5 in view) cost 0.90 ms per frame, ~0.18 ms each,
mostly per pass rather than per pixel (`2026-10-14-group-pass-cost.md`).
Reveal and fade animations on the sites put many elements at opacity < 1
at once, so this grows with the page's motion.

## Why existing knowledge doesn't resolve it

Packing many small render targets into one texture (an atlas) to share a
render pass is common for shadow maps and UI layers, but the groups here
have per-group frame mappings, clip shapes, scissors, nesting, filters
that post-process the texture (blur, drop shadows), layer transforms
that render at another scale, and region effects that read the texture.
Which groups can share a pass without changing pixels, and whether a
tile-based GPU's cost really is per pass (so that sharing helps) rather
than per target size, is not known in advance.

## Hypothesis

Rendering a parent's leaf groups (no nested group, backdrop or extra
layer inside; no layer transform, region, blur or drop shadow) into one
atlas texture in one pass, each in its own scissored rect with its own
frame mapping, and compositing each from its rect:

1. leaves the visual and fx harnesses unchanged (no new failures), and
2. on the M1 Pro cuts the groups' cost (`perf.html` `scroll`, with
   groups minus `--nodim`) by at least 60%, to at most 0.36 ms per frame.

## Why the outcome is uncertain

- On a tiled GPU, one pass over a texture holding all groups may cost
  about as much as several small passes if the cost is in the pixels
  rather than the pass boundaries; the earlier measurement inferred the
  per-pass share from SwiftShader and a single A/B.
- Bilinear sampling at a rect's edge can pick up a neighbour's pixels;
  gutters have to be wide enough.
- The atlas has to be cleared and stored as a whole; if it is much
  larger than the groups' area, that bandwidth eats the saving.

## Method

1. `gpu/renderer.ts`: `prepare` defers a parent's leaf groups, shelf-packs
   their rects (2 px gutters) into one pooled texture sized to the packed
   area, renders them in one pass (`group-atlas`) before the parent's
   own pass, and composites each from its rect (`gpu/composite.ts`: a uv
   origin per instance; the shared texture is released after its last
   composite). Groups that don't qualify, or don't fit, keep their own
   texture and pass. `CompositorOptions.groupAtlas` (default true; false
   for the A/B, `perf.html?noatlas`, `test:profile --noatlas`).
2. Checks: visual and fx harnesses in SwiftShader; a pass count in
   `stats()` (`groupPasses`).
3. Measures: `test:profile --headed --only scroll` on the M1 Pro, with
   and without `--nodim`, with and without `--noatlas`, at dpr 1 and 2.

## Results

| Measure | Before | After | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| Group passes on `perf.html` at 1200 px (5 groups), SwiftShader | 5 | 1 | - | 2026-10-15 | `2026-10-15-swiftshader.txt` |
| Pixels differing from `?noatlas` (> 2/255), same view | - | 28 of 1.15M, max 14/255, inside one dimmed card's glyph edges (deterministic: 0 between two `?noatlas` runs) | report | 2026-10-15 | same |
| Visual / fx harness failures, SwiftShader | 5 / fx-trail*, fx-displace*, fx-dissolve | the same, same numbers | no new failures | 2026-10-15 | same |
| Groups' cost per frame (with groups minus `--nodim`), M1 Pro, `scroll`, dpr 1 | 0.18 ms | 0.04 ms | at most 0.36 ms (-60%) | 2026-10-15 | `2026-10-15-m1pro.txt` |
| Same, dpr 2 with the band | 0.34 ms | -0.43 ms (below spread) | at most 0.36 ms | 2026-10-15 | same |
| `group` pass span / alone p50, M1 Pro, dpr 1 | 2.61 / 0.52 ms | 0.70 / 0.34 ms | - | 2026-10-15 | same |
| `group` pass span / alone p50, M1 Pro, dpr 2 band | 2.42 / 0.08 ms | 1.16 / 0.00 ms | - | 2026-10-15 | same |

Observations:

- The groups' cost before the atlas measured 0.18 ms (dpr 1) and 0.34 ms
  (dpr 2 band), not the 0.90 ms of the group-pass-cost experiment. Since
  then draw culling, the band and kept margins changed what overlaps the
  group passes; the cost of five groups is now small on this page.
- With the atlas the five groups take one pass, whose span falls from
  2.6 to 0.7 ms at dpr 1 (2.4 to 1.2 ms at dpr 2), and the frame with
  groups is within 0.05 ms of the frame without them at dpr 1. At dpr 2
  it measured lower than without groups, which can only be run-to-run
  spread (~10% of a 7 ms frame).

## Evaluation

Supported on its thresholds (groups' cost at most 0.36 ms, -60% or more
at dpr 1), but the absolute effect on this page, ~0.1-0.3 ms, is
smaller than the spread between runs, so the measurement doesn't
separate it cleanly. Output matches the per-group path within 28 pixels
at 14/255 (SwiftShader), and the harnesses are unchanged.

## Conclusion and next step

Known now: leaf opacity groups can share one texture and render pass
with no visible change, and the pass count falls from one per group to
one per parent. On `perf.html` five groups no longer cost much either
way; the saving should grow with the number of groups in view (reveal
and fade animations). Kept as the default. A scenario with many groups
in view (dozens of elements fading) would measure the scaling.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
