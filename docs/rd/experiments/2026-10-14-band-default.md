# Experiment: `canvasFill: 'band'` as the default

| Field | Value |
| --- | --- |
| Activity | C2 (latency vs cost of the document-space canvas, hypothesis 1) |
| Status | Concluded (stall and harness parts supported; cost with a post chain 62% of full, threshold 60%) |
| Started | 2026-10-14 |
| Concluded | 2026-10-14 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-14-band-default/` |

## Hurdle

`'band'` with kept margins holds 120 Hz at dpr 2 on an M1 Pro where
`'full'` drops two thirds of frames (`2026-10-14-band-margins.md`), but
three things keep it from being the default:

1. With a post chain running (phobon.io's trail and lens, any `fx`
   pass), it falls back to clearing the margins, so a stalled scroll
   shows blank canvas.
2. Kept rows hold whatever was last drawn there. A fixed
   (viewport-space) element is drawn at the viewport each frame; if
   rows it was drawn into leave the band without being redrawn, a
   stall could show an old copy of it.
3. The stall check has only run in software rendering (headless Chrome
   falls back to SwiftShader, on Ben's machine too).

## Why existing knowledge doesn't resolve it

(1) is a design gap: the post path draws the scene into its own texture
and composites the chain over it, and whether keeping margins there
costs another full-canvas copy per frame, and what that copy costs, is
untested. (2) depends on how the band moves relative to fixed content:
the band reaches at least two scroll steps beyond the viewport, which
suggests rows always leave it after the fixed element has moved off
them, but jumps, fixed elements outside the viewport and re-anchors are
cases that reasoning may miss. (3) software and Metal differ in what a
scissored pass and a texture copy leave behind.

## Hypothesis

With kept margins extended to the post path (the kept texture copied
into the post chain's scene texture), and a stall check that also runs
with a fixed header, with the blur pass on, scrolling up as well as
down, and headed on real hardware:

1. every stall screenshot with `'band'` matches `'full'` (no more blank
   rows, and no fixed-header copies `'full'` doesn't show);
2. the visual and fx harnesses show no new failures with `'band'` as
   the default;
3. with the blur pass on at dpr 2 on the M1 Pro, `'band'` costs at most
   60% of `'full'`'s GPU time per frame on `blur-scroll`.

## Why the outcome is uncertain

- The extra copy into the post chain's texture is another full-canvas
  read and write per frame; with the chain's own passes, it may push
  the frame back over budget at dpr 2.
- Fixed content may reach kept rows in ways not covered by the band's
  reasoning (a fixed element larger than the band's padding, jumps).
- Some fx passes may read the scene texture outside the viewport and
  depend on it being fresh.

## Method

1. `gpu/renderer.ts`: with a post chain, `'band'` draws into the kept
   texture and copies it into the scene texture before the chain;
   `canvasPin: 'viewport'` uses `'full'` (its canvas is the viewport, so
   there is no margin to keep). Default `'band'`.
2. `playground/perf.ts`: `?fixed` adds a fixed header. `test/fill/run.ts`:
   `--headed`, `--fixed`, `--blur`, `--up` (stall scrolling up), and a
   pixel comparison of each mode's stall screenshot with `'full'`'s.
3. SwiftShader: stall check in each variant; visual and fx harnesses
   with the new default. M1 Pro: stall check headed; `test:profile
   --only blur-scroll --nodim --dpr 2` with `--band` and without.

## Results

| Measure | full | band-clear | band | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- | --- |
| Stall check, down (blank rows of 900 / px differing from full), SwiftShader | 34 / 0 | 482 / 516016 | 34 / 0 | match full | 2026-10-14 | `2026-10-14-swiftshader.txt` |
| Same, up | 39 / 0 | 496 / 517994 | 39 / 40 | match full | 2026-10-14 | same |
| Same, fixed header, down | 34 / 0 | 482 / 516016 | 34 / 0 | match full | 2026-10-14 | same |
| Same, fixed header, up | 88 / 0 | 545 / 517994 | 88 / 40 | match full | 2026-10-14 | same |
| Same, blur post pass on, down | 33 / 0 | 481 / 516016 | 33 / 0 | match full | 2026-10-14 | same |
| Visual harness failures with 'band' the default, SwiftShader | 5 (container goldens) | - | the same 5, same numbers | no new failures | 2026-10-14 | same |
| fx harness failures with 'band' the default, SwiftShader | fx-trail*, fx-displace*, fx-dissolve | - | the same; fx-blur-scissor now passes | no new failures | 2026-10-14 | same |
| Stall check headed, M1 Pro: down / fixed header up / blur pass down (blank rows, px differing from full) | 34, 87, 33 / 0 | 492, 509, 491 / ~500k-529k | 34, 87, 33 / 0, 1, 0 | match full | 2026-10-14 | `2026-10-14-m1pro.txt` |
| GPU total p50 / p99, `blur-scroll --nodim --dpr 2`, M1 Pro | 19.35 / 19.64 ms | - | 12.01 / 12.35 ms (62%) | band at most 60% of full | 2026-10-14 | same |
| Main pass p50 in the same runs | 14.33 ms | - | 6.59 ms | - | 2026-10-14 | same |

Observations so far:

- The 40 differing pixels in the upward stalls are one tilted card
  (card 40) whose edge anti-aliasing differs; the same 40 pixels showed
  in the band-margins experiment.
- With the fixed header, the stall shows one header, moved with the page
  as it is with `full` (the canvas scrolls with the document until the
  next frame); no older copies in the kept rows above it.
- With the blur pass (a post chain), kept margins now hold: the band
  matches `full` exactly, where it previously fell back to clearing.
- On the M1 Pro, headed, every stall screenshot with the band matches
  `full` (0, 1 and 0 pixels differ), with the fixed header and with the
  blur pass.
- With the blur pass at dpr 2, the band cut the frame from 19.35 to
  12.01 ms, the main pass from 14.33 to 6.59 ms. The rest is the blur
  itself (its passes run 9.4 ms alongside the main pass) and the post
  composite (2.6 ms alone); neither depends on the band. Neither mode
  fits 120 Hz with the blur on at dpr 2; `full` didn't fit 60 Hz either
  (19.35 ms).
- `fx-blur-scissor`, which failed with the band before (it checks the
  canvas below the viewport after a stalled scroll with the blur pass
  on), passes with kept margins in the post path.

## Evaluation

Parts 1 and 2 supported: the stall check matches `full` on the M1 Pro
and in SwiftShader in every variant, including a fixed header and a
post chain, and the harnesses show no new failures (one fewer). Part 3
narrowly not met: with the blur pass at dpr 2 the band costs 62% of
`full` (threshold 60%), because the blur's own cost doesn't shrink with
the band; the main pass halves as before.

## Conclusion and next step

Known now: with kept margins, drawing only the band is indistinguishable
from a full redraw under a stalled main thread on this hardware, with or
without fixed elements and post chains, and costs less in every case
measured (45-62% of a full redraw at dpr 2). `'band'` stays the default.

Next:

1. The blur pass at dpr 2 (9.4 ms of passes for a fullscreen blur) is
   now the larger cost on pages that use it.
2. Spread a re-anchor's newly covered rows over a few frames (p99 10 ms
   at dpr 2 on `scroll-long`).
3. The text-edit cost (~11 ms read, ~18 ms upload per edit).

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
