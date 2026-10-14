# Review: library work 2026-10-11 to 2026-10-14, 2026-10-14

| Field | Value |
| --- | --- |
| Activity | S1, S2, X (classification below; nothing here proposed as core) |
| Attendees | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related experiments | `experiments/2026-10-14-draw-culling.md` |

Written 2026-10-14, after the work, from the commits and the conversation
it was done in. Commits: `554d0b1` (2026-10-12), `6eb8e60` (2026-10-12),
`9144dc0` (2026-10-12), `7912d39` (2026-10-13), `365fdb7` (2026-10-13),
`efc48bc` (2026-10-13).

## Question under review

How to classify the work done since the R&D records were set up, and what
evidence to keep for it.

## What the evidence showed

| Work | Commit | What was found or measured | Code |
| --- | --- | --- | --- |
| `compositor-gpu/react` provider and hooks, `compositor-gpu/dials`, presets (`spotlight`, `textStagger`, `edgeLens`, `touchTrail`) moved out of the two sites | `554d0b1` | Integration and refactoring; no technical uncertainty | X |
| Graceful degradation: canvas hidden when the GPU device is lost | `6eb8e60` | `stop()` restored the page's paint but left the last GPU frame visible over it | S2 |
| Inline SVG icons disappearing during CSS transitions | `9144dc0` (fix), `7912d39` (harness shot) | The local size recovered under a scale transform drifts by ~1e-5 px per frame (16.000001, 15.99999, ...); each value keyed a new rasterisation, decoded async, so the icon was missing for the whole transition. Snapping to 1/64 px and drawing the previous raster while a new one decodes fixed it. Reproduced and verified with a new harness shot (`fx-svg-transition`: records present on 20/20 frames, 18/20 before) | S2 (diagnosis), S1 (harness shot) |
| `filter: drop-shadow()` | `7912d39` | Known technique (offset, blurred, tinted alpha under the group). DOM-vs-GPU parity on the new `drop-shadow` section 3.60% -> 0.87% | S2 |
| `backdrop-filter` | `365fdb7` | Splits the target's render pass at the element and filters what was drawn so far. Parity on the new `backdrop` section 1.97%; a fixed glass header matched at 3 scroll offsets. Deviations recorded in ROADMAP (element opacity doesn't fade the backdrop) | S2 |
| Image atlas eviction and standalone texture expiry | `efc48bc` | Compaction by texture copy; also found that repacking recovers space lost when shelves packed at 2048 px are kept after growing to 4096 px (7 -> 9 of 9 1024 px entries). A late re-issued canvas upload (headless macOS + SwiftShader) landed in a discarded texture after a grow; fixed by resolving the destination when the re-issue happens. New harness `npm run test:atlas` | S2, S1 |

## Decision

Classify as in the table. None of it is put forward as a core activity:
the techniques are known, and the problems found were bugs or fitting
known techniques to this renderer. They support C2 by keeping page-level
parity measurable on real pages (both sites use drop shadows,
backdrop-filter and inline SVG icons).

## Actions

- [ ] Ben: log hours for this period in `records/timesheet.csv` under the
      codes above.
- [ ] Ben: save the visual-harness output for the `drop-shadow` and
      `backdrop` sections (parity tables and diff PNGs) to `evidence/` if
      they are to be kept; only the numbers above are recorded here.
