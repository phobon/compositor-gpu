# Experiment: layer transforms, region passes and static materials as damage

| Field | Value |
| --- | --- |
| Activity | C2 (latency vs cost of the document-space canvas) |
| Status | Concluded (partly supported: saving smaller than predicted on `fx-one`) |
| Started | 2026-10-17 |
| Concluded | 2026-10-18 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-17-layer-damage/` |

## Hurdle

`skipUnchanged` (`2026-10-16-skip-unchanged.md`) keeps the kept texture
between frames and redraws only rows that changed, but any `/fx` layer
transform (`fx.transform`, `fx.motion`), active region pass (a region
`blur`), or active `/fx` material turns it off: every frame then
redraws the whole band (~7 ms of GPU time at dpr 2 on an M1 Pro over
`perf.html`). The sites animate a few elements at a time through these
(the `/duo` bento reveal: cards rising through `fx.transform` under
region blurs), so the saving doesn't reach them while anything animates,
nor while a static material is merely present.

## Why existing knowledge doesn't resolve it

A layer transform composites its element's group through an affine, so
the pixels it changes are bounded by the group's extent before and after
the transform (`layerAffine`, `groupExtent`); a region pass draws its
group through a handler within its extent grown by the handler's `pad()`;
a material that reports `changed() === false` draws the same as last
frame. None of that is used yet to bound what a frame must redraw.
Whether those bounds are complete (a handler drawing outside its pad, a
transform nested in another), and whether redrawing a few cards' rows
per frame is cheaper than the band when several animate at once, isn't
known.

## Hypothesis

With damage for these (the rows of every transformed or region-drawn
group at this frame's and the previous drawn frame's values, when any
transform value changed or a region is active; materials count as a
change only while one reports `changed()` true or the set of active ones
changes; nested or viewport-space isolated groups keep the full redraw),
on the M1 Pro, headed, `perf.html` (n = 400, `--nodim --dpr 2 --band`):

1. `fx-one` (one card bobbing through `fx.transform`, page still): GPU
   total p50 at most 3 ms (the band redraw: ~7 ms, `--noskip`).
2. `fx-transforms` (up to 30 cards in view animated) and `reveal` (12
   cards rising under region blurs): GPU p50 no higher than `--noskip`,
   no dropped frames.
3. Visual, fx (which covers transforms, regions and materials, including
   "then off" shots that must match exactly), edit and stall checks
   unchanged.

## Why the outcome is uncertain

- With many cards animating, the damage covers most of the viewport, as
  several scissored draws instead of one; that may cost more than the
  band.
- A region handler or transform could paint outside the bounds used
  (shadows, blur beyond `pad()`); the fx harness checks only its shots.
- A material that reports `changed() === false` while its uniforms
  changed through a path the report doesn't see would leave stale
  pixels.

## Method

1. `gpu/renderer.ts`: `layerState` (doc-y rows of isolated groups under
   an active region or a layer transform, at their current affine and
   extent, padded by the region's `pad()`; a key of the transform values
   and active regions; `fallback` for nested or viewport-space ones);
   `contentChanged` drops the blanket transform and region tests, and
   treats materials by `changed()` and the active set (`activeMats`);
   `skipFrame` doesn't skip while a region is active or the key changed;
   the trimmed band adds the layer rows at this frame's and the last
   drawn frame's values (`layerRows`, `layerKey`). `perf.html` scenario
   `fx-one`.
2. Run: `PROFILE="--only fx-one,fx-transforms,reveal --nodim --dpr 2
   --band" pnpm test:round docs/rd/evidence/2026-10-17-layer-damage
   --noskip`.

## Results

| Measure | Baseline | Result | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| `fx-one` GPU total p50 / p95 / p99 / max, M1 Pro, headed, `--nodim --dpr 2 --band`, runs 2 and 3 | 6.16 / 6.83 / 7.60 / 14.66 and 6.01 / 6.40 / 7.83 / 16.30 ms (`--noskip`, same rounds) | 4.19 / 6.73 / 15.00 / 15.16 and 4.26 / 6.39 / 14.34 / 16.65 ms | p50 at most 3 ms | 2026-10-17 | `2026-10-17-m1pro-run2-profile.txt`, `-run3-profile.txt`, `--noskip` files |
| `fx-transforms` GPU p50 / p99, runs 1-3 | 6.85-6.92 / 8.24-11.16 ms | 6.92-7.16 / 8.76-11.76 ms | p50 no higher | 2026-10-17 | `2026-10-17-m1pro-profile.txt`, `-run2-`, `-run3-` |
| `reveal` GPU p50, runs 1-3 | 8.85-9.44 ms | 8.18-8.46 ms | no higher | 2026-10-17 | same |
| `reveal` frames dropped, runs 1-3 | 29 / 36 / 29 | 60 / 27 / 27 (run 1: one 283 ms hitch, not repeated) | report | 2026-10-17 | same |
| `fx-one`, `fx-transforms` frames dropped | 0 | 0 | 0 | 2026-10-17 | same |
| Visual, fx (transforms, regions, materials, "then off" shots), edit, stall checks | - | OK / OK / 0 px / 0 px both ways | unchanged | 2026-10-17 | `2026-10-17-m1pro-round.txt` |

Observations:

- `fx-one` costs about a third less (4.2 against 6.1 ms at p50), not the
  ~2.5 ms predicted: a `perf.html` card is a few hundred CSS px tall, so
  its rows at two positions plus padding are about a quarter to a third
  of the band, and the card's group is re-rendered and composited each
  frame on top of the copy.
- `fx-one`'s p99 rose to 14-15 ms (noskip 7.6-7.8) with the same max:
  two of its 122 frames cost ~15 ms instead of one. The transform's
  creation and destruction each re-read the card (two partial reads in
  both modes); which extra frame is the second slow one isn't visible
  in these reports, which keep percentiles only.
- With 12 or 30 cards animating (`reveal`, `fx-transforms`) the damage
  covers most of the viewport: `fx-transforms` is unchanged within run
  spread (+0.1-0.3 ms at p50) and `reveal` is 0.6-1.0 ms cheaper at p50
  with fewer dropped frames (27 against 29-36) in runs 2 and 3. The
  283 ms hitch in run 1's `reveal` didn't recur in either repeat; it
  followed the first frame using the region blur in that browser.
- The fx harness's "then off" shots matched exactly, so the transform
  and region bounds left nothing stale in the scenes it covers.

## Evaluation

Partly supported. Hypothesis 1 missed its threshold (4.2 against 3 ms)
but cut a single animated card's frame by a third; hypothesis 2 holds
(`fx-transforms` unchanged, `reveal` cheaper, no new drops in the
repeats); hypothesis 3 holds (all checks unchanged).

## Conclusion and next step

Known now: layer transforms and region passes can be handled as damage
bounded by their groups' extents at the old and new affine; the
saving scales with how much of the viewport the animated elements
cover, and is nothing once they cover most of it. Static `/fx`
materials no longer cost a redraw.

Next:

- `fx-one`'s second ~15 ms frame: record with `--save` and read the
  per-frame samples to see which frame it is.
- A transformed group is re-rendered into its texture every frame even
  when only its affine changed; keeping the texture while the group's
  content is unchanged would take its render out of animated frames.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
