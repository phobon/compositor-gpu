# Experiment: a downsampled fullscreen blur

| Field | Value |
| --- | --- |
| Activity | C2 (low-latency DOM-to-GPU synchronisation; effects on the mirror) |
| Status | Concluded (partly supported: no dropped frames at 120 Hz, frame 7.5 ms against a 6 ms threshold) |
| Started | 2026-10-15 |
| Concluded | 2026-10-15 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-15-blur-downsample/` |

## Hurdle

With the fullscreen blur pass on (`fx` `blur`, radius 8 CSS px) at dpr 2
on an M1 Pro, the frame costs 12.0 ms with the band and 19.4 ms with a
full redraw (`2026-10-14-band-default.md`); the blur's two stages run
~9.4 ms of it. At 120 Hz the budget is 8.3 ms, so a page using the blur
drops frames on a Retina display whatever the canvas does.

## Why existing knowledge doesn't resolve it

The pass is a separable Gaussian at full device resolution: at radius
16 device px, 33 taps per pixel per axis over a 2560x1800 viewport. The
standard remedy for wide blurs (render at reduced resolution, upsample;
used by game engines for bloom and depth of field) is known, but the
fx chain has no notion of a stage resolution: every stage renders a
full-size target, the shader maps fragment positions and source texels
in canvas device px, and the scale at which the half-resolution result
stops matching the full-resolution one closely enough for this library's
harness (0.5% of pixels) depends on the radius and the content.

## Hypothesis

Letting a fullscreen pass run every stage but its last at 1/2
resolution (the last upsamples while writing full resolution), with the
blur as horizontal and vertical stages at half resolution and a copy at
full, when its radius is at least 8 device px:

1. cuts the blur's GPU time on `blur-scroll --nodim --dpr 2` on the M1
   Pro by at least 70% (frame total at most 6 ms with the band, so 120
   Hz holds), and
2. keeps `fx-blur`, `fx-blur-scissor` and `fx-blur-then-off` within the
   fx harness's 0.5% gate against the full-resolution goldens.

## Why the outcome is uncertain

- A stage at half resolution samples the full-resolution scene once per
  tap; bilinear filtering averages 2x2 texels, and narrow details can
  alias or shimmer as the page scrolls in half-pixel steps.
- The extra copy stage is another pass over the whole viewport; on a
  tiled GPU a pass's fixed cost may eat part of the saving.
- Other fullscreen passes share the chain's coordinate mapping; any that
  assumed full-resolution targets must be unaffected.

## Method

1. `fx/shader.ts`: `Effect.scale` (the stage's output scale) and
   `Effect.src_scale` (its source's); fragment uv and source texel maps
   use them (both 1 = today's behaviour). `fx/effects.ts`: a pass option
   `downsample` (a number or a function of params and dpr); fullscreen
   chain stages except a pass's last render at 1/downsample into the
   ping targets. Region passes are unchanged.
2. `fx/presets/blur.ts`: stages [horizontal, vertical, copy];
   `downsample` 2 when radius x dpr >= 8, else 1; taps scale with the
   source and target scale.
3. Measures: `test:profile --headed --only blur-scroll --nodim --dpr 2`
   with `--band`, before (git stash) and after; fx harness blur shots
   against the goldens; SwiftShader for the plumbing.

## Results

| Measure | Before | After | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| Blur GPU time p50 (`fx:blur` + `post`), SwiftShader, `blur-scroll --nodim --band` (7 frames) | 530 ms | 115 ms (-78%) | - | 2026-10-15 | `2026-10-15-swiftshader.txt` |
| fx harness blur shots (fx-blur, -scissor, -then-off, fx-region) vs full-resolution goldens, SwiftShader | - | 0.00% each | 0.5% | 2026-10-15 | same |
| Raw difference to the goldens: max channel / mean / pixels > 8 (fx-blur; fx-blur-scissor) | - | 8 / 0.37 / 0; 31 / 0.03 / 38 | report | 2026-10-15 | same |
| Rest of the fx harness | fx-trail*, fx-displace*, fx-dissolve fail (container goldens) | the same | no new failures | 2026-10-15 | same |
| GPU total p50 / p99, M1 Pro, `blur-scroll --nodim --dpr 2 --band` | 12.00 / 12.94 ms | 7.49 / 10.02 ms | at most 6 ms p50 | 2026-10-15 | `2026-10-15-m1pro.txt` |
| Dropped frames at 120 Hz, same | 49 of 137 | 0 of 139 | - | 2026-10-15 | same |
| Post composite alone p50, same | 2.61 ms | 0.41 ms | - | 2026-10-15 | same |
| Blur's share of the frame: GPU total minus the same scroll without blur (7.06 ms, 2026-10-14 band-margins) | ~4.9 ms | ~0.4 ms (-91%) | -70% | 2026-10-15 | same |
| fx-blur vs Ben's goldens (headless, SwiftShader) | - | 0.00% | 0.5% | 2026-10-15 | same |

Observations:

- The pass spans overlap on Chrome/Metal (`fx:blur` reads 13.7 ms after,
  9.4 ms before, with 0 ms alone in both), so the blur's own cost is
  read from the frame total: 12.0 ms with it at full resolution, 7.5 ms
  at half, against 7.1 ms for the same scroll without a blur in an
  earlier session. The estimate of -91% crosses sessions (run-to-run
  spread ~10%); the frame-total drop of 4.5 ms within this session is
  firm.
- The upsampling copy writes the canvas in the post composite: alone
  0.41 ms, against 2.61 ms when the vertical axis ran there at full
  resolution.

## Evaluation

Partly supported. The blur's cost fell by roughly 90% and the frame
went from 12.0 to 7.5 ms with no dropped frames at 120 Hz (49 dropped
before), and quality stays within the harness gate (raw difference at
most 8/255 on fx-blur). The 6 ms threshold for the whole frame was not
met: what remains is the band's main pass and copy (~7 ms at dpr 2),
not the blur.

## Conclusion and next step

Known now: a wide fullscreen blur can run at half resolution on this
mirror with no visible change at radius >= 8 device px, and costs a
fraction of a millisecond at dpr 2 on an M1 Pro. The frame's floor with
the band at dpr 2 is the main pass and the kept-texture copy, ~7 ms on
`perf.html`; the next fill work (re-anchor spreading) targets its tail.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
