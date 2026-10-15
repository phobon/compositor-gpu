# compositor-gpu: R&D Tax Incentive activity draft, FY2026-27

Draft as of 2026-10-13, Ben McCormick. Working copy also in Claude Docs:
https://claude.ai/code/artifact/88fb2d06-be0f-4235-92ea-499283ca54ea
(this file is the one to keep current).

## Summary

Three core R&D activities are proposed for compositor-gpu, each with
supporting work. Everything else in the repo is either supporting or not
claimed. This is a working draft for an R&D tax adviser to review, not a
lodged registration.

| Item | Detail |
| --- | --- |
| Project | compositor-gpu: mirrors a live web page onto the GPU, kept in sync with the DOM |
| Claimant | Bonobo (entity type to confirm: must be a company) |
| Income year | FY2026-27 (1 Jul 2026 to 30 Jun 2027); work began 24 Sep 2026 |
| Registration due | 30 Apr 2028 (10 months after year end) |
| Evidence base | 83 commits (24 Sep to 13 Oct 2026), ROADMAP.md, docs/HANDOFF.md, docs/ARCHITECTURE.md, docs/EFFECTS.md, test harness output |

Each core activity follows the guide's structure: the technical hurdle, why
existing knowledge didn't solve it, the hypothesis, the experiment, and the
result. Figures come from the repo docs; check them against the harness
output files before lodging.

## Project overview

The goal is to repaint a real, accessible HTML page on the GPU, every frame,
so that shaders can run over it. The browser stays responsible for layout.
The project reads the browser's computed geometry (boxes, images, per-glyph
positions) and redraws it with WebGPU. Text is drawn from the font's vector
outlines with the Slug algorithm.

To be useful the GPU copy has to meet three conditions at once:

- **Fidelity:** pixel-level agreement with the browser's own paint (target:
  under ~1% of pixels differing per section).
- **Latency:** stays in step with scroll, resize, DOM mutation and CSS
  animation, with no visible lag behind the page.
- **Cost:** reading geometry and encoding a frame fits within a 60-120 Hz
  frame budget on real pages.

**Why this wasn't solvable from existing knowledge.** Existing approaches do
only part of this (details and check dates in `prior-art.md`):

- html2canvas and similar re-implement CSS layout and render a one-off
  snapshot. They aren't real time and diverge from the browser.
- three.js CSS3DRenderer moves real DOM elements with CSS transforms.
  Shaders can't touch their pixels.
- The WICG "HTML-in-Canvas" proposal (drawing elements into a canvas) is an
  experimental Chromium feature, not cross-browser, and gives no per-glyph
  access.
- Browser APIs give per-glyph geometry only through Range queries, and each
  one can force a layout. Reading every glyph on a real page is too slow for
  real-time use (see C1).

No published method was found for keeping a GPU copy of an arbitrary live
page at sub-1% pixel parity, in real time, across browsers. The open
questions listed under each activity are the parts a competent web or
graphics engineer couldn't answer in advance.

## C1. Real-time per-glyph geometry from browser layout

**Hurdle.** The GPU copy needs the position of every grapheme as the browser
laid it out. Browsers expose this only through `Range` rect queries, and each
one can force a layout. On a 400-card test page (~84k glyphs) a full read
took 587 ms in Chrome. On the real site, Safari's read was ~65x Chrome's
(frame time 49 ms vs 0.7 ms). No documented technique gives per-glyph
positions at real-time cost without re-implementing text shaping, which the
project rules out.

**Hypothesis.** Canvas 2D `measureText` suffix widths, in the element's
computed font, match the browser's layout closely enough (within 0.05 px) to
place graphemes inside each line from a single `getClientRects()` call per
text node. Where they don't match, fall back to one Range per
whitespace-free chunk, then per grapheme. The outcome was uncertain because
canvas text measurement and DOM layout are separate code paths. Whether they
agree depends on browser, font features, optical size, ligatures,
transforms and script.

**Experiment.**

1. Implement the split behind a `FAST_TEXT_READ` flag, with a per-chunk
   check against the browser's rects and a per-font give-up after 8 misses.
2. Count Range queries and per-grapheme fallbacks (`stats().textRead`) on
   `perf.html` and the playground sections.
3. Run the visual-regression harness to confirm the mirror is unchanged.
4. Extend to transformed elements by measuring in the element's local frame.

**Results so far (Chrome/SwiftShader).**

| Measure | Before | After |
| --- | --- | --- |
| Range queries per full read (perf.html) | 84k | 15k (7.8k with transforms) |
| Full read time | 587 ms | ~430 ms (-26%) |
| Text-node read alone | baseline | ~2x faster |
| Graphemes still on the slow path | 100% | 12.9% |
| Visual regression | - | 0.00% on every section |

The remaining slow path comes from 16 px titles where the optical-size axis
differs between canvas and layout, and from rotated cards. Ligature
candidates, non-Latin scripts, emoji, bidi and justified text are sent to
the slow path on purpose.

**Still uncertain.** It hasn't been measured whether WebKit's canvas metrics
match its layout. If they don't, Safari falls back to per-grapheme reads and
the hypothesis fails for that browser. Planned:
`experiments/2026-10-safari-fast-text-read.md`.

**Evidence.** ROADMAP.md item 1 ("Safari"); CLAUDE.md performance-harness
section; `src/dom/textRuns.ts`; `test/perf/out/last.json`;
`test/perf/out/profile.txt` (1103 -> 332 ms native over five reads).

## C2. Low-latency DOM-to-GPU synchronisation at pixel parity

**Hurdle.** The GPU copy must stay in step with a page that scrolls,
resizes, mutates and animates, without re-reading layout every frame. It
must also reproduce the browser's compositing (stacking contexts, opacity
groups, transforms, clips, filters, elements excluded from the mirror)
closely enough to be indistinguishable. Browsers don't expose their paint
order or compositor state. Scroll runs on a separate compositor thread that
page scripts can't synchronise with. No known method keeps a script-driven
GPU layer frame-aligned with native scroll.

**Hypotheses tested.**

1. *Scroll lag.* A canvas positioned in document space (`position:
   absolute`, oversized by one viewport above and below, re-anchored only
   when the viewport leaves it) would be moved by the browser's compositor
   thread together with the DOM. This would remove the one-frame lag seen
   with a fixed canvas updated from scroll events. Unknown in advance: the
   fill-rate cost, and how fixed and sticky content would behave.
2. *Partial reads.* Re-reading only the subtree around a mutation, and
   escalating to a full read only when that subtree's border box moved,
   would keep idle and animated frames under ~1 ms without missing layout
   changes.
3. *Paint order.* A simplified CSS stacking-context tree, flattened into one
   integer paint order per record, with offscreen groups for opacity and
   filters, would reproduce Chrome's paint order within the parity target.
4. *Excluded elements.* Erasing the mirror under excluded elements
   (destination-out at the element's paint position) would let the page's
   own paint show through, in both overlay and replace modes.

**Experiments and results.**

| Hypothesis | Result |
| --- | --- |
| 1. Document-space canvas | Lag removed. Measured cost: canvas up to 3x viewport area; SwiftShader steady fps fell ~5.5 -> ~2 (needs checking on real hardware). Fixed content still trails by up to a frame, so a viewport-pinned variant was added for viewport effects. |
| 2. Partial reads | 400-card page: partial read ~40 ms vs ~430 ms full. Live site: 0.6 ms read per frame at idle. A bug where any mutation cancelled the exemption for running animations caused 2 escalations per carousel switch; after the fix, 0. |
| 3. Paint order | Section parity 0.06-1.06% (images 2.9% from resampling) across 28 shots. |
| 4. Excluded elements | First attempt left a blank page in replace mode (hidden elements were read as opacity 0). Fixed by recording their prior opacity; now covered by a harness case. Holes for fixed elements trail while scrolling, so those sit above the canvas instead. |
| 17. Group atlas (`experiments/2026-10-15-group-atlas.md`) | Leaf opacity groups (nothing nested, no transform, region, blur or shadow) now share one texture and render pass per parent, each in a shelf-packed rect. Five groups on perf.html went from five passes to one; on an M1 Pro their cost fell from 0.18 to 0.04 ms per frame at dpr 1, an effect below run-to-run spread on a page with few groups. Output matches the per-group path within 28 px at 14/255. |
| 16. Downsampled fullscreen blur (`experiments/2026-10-15-blur-downsample.md`) | A `downsample` option for fullscreen passes (all stages but the last at 1/n resolution, the last upsampling) let the blur run at half resolution from 8 device px of radius. At dpr 2 on an M1 Pro the frame with the blur fell from 12.0 to 7.5 ms (the blur ~4.9 to ~0.4 ms), no dropped frames at 120 Hz against 49 of 137, within the visual harness's gate. |
| 15. In-place scene patch for edits (`experiments/2026-10-14-edit-patch.md`) | When a partial read leaves the re-read records' structure unchanged, the new records replace the old in place (keeping paint order and buffer positions), batches are rebuilt only if geometry moved, and only the changed text runs are re-packed. Output matches a rebuild (0 px, 18 edits). On an M1 Pro a class toggle costs 2.3 ms (from 32.0) and a word swap 11.8 ms (from 31.2); the remainder of a word swap is page-wide batching and culling. |
| 14. Edit cost attribution (`experiments/2026-10-14-edit-cost.md`) | Profile rows for the scene rebuild, batches and text upload showed a one-word edit on a 400-card page costs 31 ms on an M1 Pro: 10.5 ms rebuilding the whole scene (7.6 ms of it building batches) and 16.3 ms re-packing all text, against 0.6 ms reading the edited card. |
| 13. Band as the default (`experiments/2026-10-14-band-default.md`) | Kept margins extended to post chains (the kept texture copied into the chain's scene texture). Stall checks with a fixed header, upward stalls and a blur pass match a full redraw on an M1 Pro (0-1 px differ) and in SwiftShader; harnesses show no new failures. With the blur at dpr 2 the band costs 62% of a full redraw (threshold 60%), the blur's own cost not shrinking. `'band'` made the default. |
| 12. y index for culling (`experiments/2026-10-14-cull-index.md`) | Bucketing instances by y, built in idle time, gave identical runs (2600 random checks) and cut the worst recompute 14 to 5 ms in SwiftShader and in band mode on an M1 Pro (1.0 vs 1.5-3.9 ms), but not in full mode (2.9 vs 2.4-2.6 ms), whose first recompute may come before the index is ready; two in-frame build designs were rejected for moving the cost into edit or scroll frames. The profile showed the larger cost: ~11 ms read and ~18 ms upload per text edit. |
| 11. Encode spike attribution (`experiments/2026-10-14-cull-spike.md`) | Timing draw culling separately (`stats().cullMs`, a `cull` row in the profile) showed the one slow encode per scroll is the cull recompute (2.4 of 2.5 ms on an M1 Pro, 14.3 of 14.8 ms in SwiftShader). Its first calls run a loop over every instance on the page before the JIT optimises it. Next: a y-bucketed index so a recompute visits only nearby records. |
| 10. Kept margins for the band (`experiments/2026-10-14-band-margins.md`) | A WebGPU canvas doesn't keep pixels between frames, so the band now draws into its own texture (redrawn only in the band, shifted by a copy when the canvas re-anchors) and copies it to the canvas. A stalled scroll then shows the same picture as a full redraw (SwiftShader), and at dpr 2 on an M1 Pro the frame costs 45-50% of a full redraw with no dropped frames, against 68% dropped. Open: post chains fall back to clearing; re-anchor frames reach 10 ms. |
| 9. Cull recompute cost (`experiments/2026-10-14-cull-recompute.md`) | A scroll that crosses draw culling's cached region costs up to 5 ms of main-thread time per recompute on an M1 Pro (35.6 ms in SwiftShader). Precomputing each instance's bounds once per scene change cut the p99 2-3x (to 0.8-0.9 ms) but left one 4-6 ms frame per scroll, not yet attributed. Next: time the recompute directly, then a y-bucketed index if culling is the cause. |
| 8. Band culling and the band at dpr 2 (`experiments/2026-10-14-band-culling.md`) | Culling draws to the band halved its instances but didn't speed the band at dpr 1 on an M1 Pro (87% of full vs 75% culled to the canvas), so the dpr 1 gap isn't off-band geometry. At dpr 2 the full canvas took 14.1 ms of the 8.3 ms budget and dropped 170 of 251 frames; the band cut it 53-58% with none dropped. The cull recompute costs up to 6.8 ms of main-thread time on a 400-card page. Next: a cheaper cull recompute, and keeping the margins' contents so a band is safe to adopt. |
| 7. Fill cost of the margins (`experiments/2026-10-14-fill-cost.md`) | Drawing only the viewport plus a scroll-sized band cut the main pass 60% in software rendering but only 26% on an M1 Pro at dpr 1 (5.09 -> 3.78 ms; threshold 40%), because tiled-GPU vertex, binning and clear/store work doesn't shrink with the scissor; and a stalled main thread then reveals blank canvas over half the viewport. Kept as an option, not the default. |
| 6. Opacity-group cost (`experiments/2026-10-14-group-pass-cost.md`) | The profiler's per-pass GPU times overlap on Chrome/Metal (group passes reported 2.63 ms, ran alone 0.43 ms). An A/B without groups put their real cost at 0.90 ms per frame on an M1 Pro (~0.18 ms per group), mostly per pass rather than per pixel (2.4% in software rendering). Next: one pass for all groups. |
| 5. Draw culling (`experiments/2026-10-14-draw-culling.md`; classification to confirm) | Splitting paint-order batches into on-canvas instance runs cut instances per frame 85% and draws 123 -> 33 on perf.html with no pixel change traced to it, but frame time didn't follow: -12% in SwiftShader, no measurable change on an M1 Pro (GPU p50 5.66 vs 5.75 ms). The GPU cost is fill on the 3-viewport canvas and the opacity-group passes, which become the next experiments. |

**Failed or dropped approaches.** A pre-hide head script (reverted the same
day); a hero load dissolve (dropped: long blank wait, glitchy); mipmaps for
scaled layers (measured blurrier than Chrome's re-raster, so replaced with
axis-scaled textures snapped to the pixel grid).

**Evidence.** ROADMAP.md items 2-4 and Phase 1 scroll item; docs/HANDOFF.md
items 3, 4 and 7; commits `d916275` (scroll-driven canvas),
`1094210`/`526fdd2` (cutouts), `2f997db` (replace mode), `8cc910d`
(stacking contexts), `21ec967` (subtree reconciliation);
`npm run test:visual` and `test:site` output.

## C3. Outline text rendering matched to browser layout

This is the weakest of the three. Slug's reference shaders are published
(MIT, patent in the public domain since March 2026), so porting them is
routine. The claim should cover only the new problem: making
outline-rendered glyphs match what the browser drew, when the positions come
from the browser rather than from your own shaper.

**Hurdle.** The browser gives a rect per grapheme, not a glyph origin,
baseline or advance. Its rasteriser applies its own rounding, anti-aliasing
weight, optical-size instancing and ligature handling. It wasn't known
whether outline rendering placed into those rects could reach browser
parity, or what corrections would be needed.

**Hypotheses and results.**

| Hypothesis | Result |
| --- | --- |
| Rounding ascent/descent to whole CSS px before splitting the half-leading, and snapping the baseline to a device pixel, reproduces Blink's glyph placement | Text section parity 4.05% -> 2.15%; body-text error halved |
| Two rays per direction across row and column bands, a coverage gamma of 0.87, and a quad grown by one device pixel reproduce Chrome's stem weight | Text parity 0.95% -> 0.36%; thin edge stems fixed |
| Instancing a variable font per (weight, optical size), with opsz = font-size, matches the browser's choice of cut | Headings use the Display cut as Chrome does; 16 px titles still mismatch (feeds C1's slow path) |
| Drawing the ligature glyph across abutting component graphemes matches Chrome, which splits a ligature's advance across them | fi/fl/ffi match; disabled under letter-spacing, as Chrome does |
| Graphemes Slug can't draw (emoji, missing code points, clusters) can share one instance index space with an atlas fallback without breaking batch order | Working; atlas paint order within a batch still open |

During the variable-font work a parsing bug in opentype.js 2.0 was found and
diagnosed (packed point count 0 read as "no points"). This is bug fixing, so
list it as supporting (S3), not core.

**Evidence.** ROADMAP.md Phase 1; commits `602d3e3`, `7f43a9a`, `4ae9306`,
`3be5866`, `014426e`, `f4e2fbf`; `src/text/slug/README.md`;
docs/UPSTREAM-gvar.md.

## Supporting activities

These count only to the extent they directly served the core experiments.
Time on each should be apportioned, not claimed in full.

| Code | Activity | Supports | Why it's needed |
| --- | --- | --- | --- |
| S1 | Visual-regression harness (`test:visual`, DOM vs GPU parity, goldens, headless WebGPU) | C1, C2, C3 | The measurement instrument for every parity result |
| S1 | Performance harness and frame profiler (`test:perf`, `test:profile`, `compositor.profile`) | C1, C2 | Measures read/encode cost and finds the causes of slow frames |
| S1 | Site harness (`test:site`) | C2 | Tests the hypotheses on a real page, not just the playground |
| S1 | Playground pages (`perf.html`, `atlas.html`, test sections) | C1, C2, C3 | Controlled test cases for each experiment |
| S2 | Box, image and gradient passes; transforms; pseudo-elements; clips | C2 | Needed to measure page-level parity; mostly known techniques |
| S2 | Image atlas and eviction | C2 | Keeps draw counts low enough to measure frame cost |
| S3 | opentype.js gvar diagnosis and workaround | C3 | Unblocked variable-font testing |

## Not claimed (X)

- **Effects layer** (`compositor-gpu/fx`: blur, ripple, displace, dissolve,
  materials, motion API). Mostly applying known shader techniques. Revisit
  if a specific effect involved an experiment with an unknown outcome.
- **React provider and hooks, DialKit panels, reduced-motion support.**
  Routine integration.
- **bonobolabs.com `/duo` integration** (GSAP reveals, scrubs, section
  layout). Site work, using the library as a component.
- **Packaging, build, lint, docs, git housekeeping.**

## Record-keeping gaps

The repo's own records were written as the work happened, which helps. The
commits, ROADMAP, HANDOFF and harness results show what was tried, measured
and dropped. What's missing is the framing an assessor expects, and a link
from that framing to time and cost.

- [x] Set up `docs/rd/` with templates for experiments, prior art, reviews,
      timesheet and expenditure.
- [ ] Write experiment files for the concluded C1-C3 hypotheses above,
      marked as written after the fact, with the commit dates as evidence.
- [ ] Keep harness outputs (`last.json`, parity tables, diff PNGs) for each
      experiment in `evidence/`, not only the latest run. Goldens are
      gitignored, so save a dated copy.
- [ ] Record time spent per core and supporting activity in
      `records/timesheet.csv` (weekly is enough), from 24 Sep 2026 on.
- [ ] Keep invoices for tools used on the R&D (e.g. Claude subscription) in
      `records/expenditure.csv`, with the share used for it.
- [ ] Verify the prior-art entries in `prior-art.md` with dates and links.
- [ ] Run the Safari experiment from C1 and record the result, whichever way
      it goes.

## Open questions for the adviser

- Is Bonobo a company (Pty Ltd)? Sole traders, partnerships and trusts can't
  register.
- Will eligible spend reach the $20k minimum for FY2026-27? Is Ben paid a
  salary for this work? Unpaid founder time doesn't count.
- Is C3 strong enough to claim as core, or better folded into C2?
- Should C1 and C2 stay separate? The guide warns against bundling too much
  into one core activity.
- Does publishing the library under MIT, or using it on bonobolabs.com,
  affect anything? (Not expected to.)
- Should an Advance Finding be considered, given the work continues past
  this year?
- Aggregated turnover band, which sets the offset rate (refundable if under
  $20M).
