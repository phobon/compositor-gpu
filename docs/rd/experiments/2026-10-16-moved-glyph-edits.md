# Experiment: edits that move glyphs without re-batching the page

| Field | Value |
| --- | --- |
| Activity | C2 (low-latency DOM-to-GPU synchronisation at pixel parity; partial reads) |
| Status | Concluded (supported) |
| Started | 2026-10-16 |
| Concluded | 2026-10-16 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-16-moved-glyph-edits/` |

## Hurdle

A same-length word swap on `perf.html` (n = 400) costs 11.8 ms of
compositor CPU on an M1 Pro (p99 19 ms), against 2.3 ms for a class
toggle that moves nothing (`2026-10-14-edit-patch.md`). The records are
replaced in place, but because glyphs moved the whole batch list is
rebuilt (6.6 ms, plus 1.7 ms of per-run rect unions and material tags)
and the new list throws away the draw-culling bounds, whose recompute
costs another 2.1 ms. All three are proportional to the page, not to the
edit.

## Why existing knowledge doesn't resolve it

The batch builder (`scene/batches.ts`) merges records greedily in paint
order and lets a record join an earlier batch of its layer when its
footprint overlaps nothing painted in between. That decision depends on
every record's footprint, so a moved glyph can in principle change it
anywhere. What is not known is whether checking only the moved records
against the existing list is enough to keep it correct, how often that
check fails on real edits (falling back to the rebuild), and whether
the culling bounds and their y index can be patched for the moved
instances without a full recompute.

## Hypothesis

1. An existing batch list stays correct for new geometry if no moved
   record's new footprint overlaps a record in another batch whose paint
   order relative to it is inverted by the list (a later-painted record
   in an earlier batch, or an earlier-painted one in a later batch).
   Checking that for the moved records only, against the members kept
   from the last batch build, and keeping the list when it holds, leaves
   the edit, visual and fx harnesses unchanged (edit harness: 0 px
   between patched and rebuilt canvases).
2. With that check, and the culling bounds updated in place for the moved
   instances (keeping the y index when they stay in their buckets),
   `mutate-text` on `perf.html` (M1 Pro, headed, dpr 1, n = 400) costs at
   most 4 ms of compositor CPU per edit (p50; 11.8 ms before), with its
   p99 under 8 ms.

## Why the outcome is uncertain

- The check may fail often: a word swap moves glyphs along a line inside
  a paragraph whose run sits in a large text batch, and boxes painted
  between (decorations, highlights, links) could block it.
- Keeping each batch's members (a grid of footprints with their paint
  order) after the build costs memory and some build time; the build
  itself may get slower.
- The member grids go stale as records move (old footprints stay); a
  stale footprint can only make the check stricter, but if it fails more
  often over time the gain shrinks between rebuilds.
- Updating the culling bounds in place must keep the visible-instance
  runs exact; a moved instance that changes y buckets needs its index
  dropped and rebuilt in idle time, which costs a walk on the next query.

## Method

1. `scene/batches.ts`: `buildBatches` optionally hands back what it built
   (each batch's member grid with each member's paint index, bounds and
   instance range); `refitBatches` checks the moved records against it
   and adds their new footprints. `scene/scene.ts`: `Scene.refit(pairs)`
   instead of `rebatch()` for moved patches, falling back to the rebuild
   (members carry the refit that added them, so a moved record's older
   footprints are skipped; whitespace glyphs have no footprint);
   the moved records are queued for the culler (`moved`, `geometry`
   counter). `gpu/cull.ts`: `updateBounds` writes the moved instances'
   new bounds into the cached arrays and drops a layer's y index only if
   one moved out of its buckets; the renderer recomputes the culled runs
   when the geometry counter changes. `CompositorOptions.refitBatches`
   (default true; `perf.html?norefit`, `test:profile --norefit`) for the
   A/B; `stats().refits` counts kept lists.
2. Checks: `test:edit` (moved edits: heading swaps, word swaps), visual
   and fx harnesses in SwiftShader.
3. Measures: `pnpm test:profile -- --headed --only mutate-text,mutate-class`
   with and without `--norefit`, same session, M1 Pro, dpr 1 (as the
   edit-patch baseline), then dpr 2 with the band.

## Results

| Measure | Baseline | Result | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| `refitBatches` on synthetic records: keeps the list for safe moves, refuses a move under a later-painted record merged into an earlier batch, two records moved onto each other, and accepts sequential moves through each other's old places | - | all as expected | - | 2026-10-16 | `2026-10-16-swiftshader-checks.txt` |
| `test:edit` (10 moved edits among 21 reads), SwiftShader | - | batches kept for all 10; 0 px differ from a rebuild | 0 px | 2026-10-16 | same |
| Visual harness, SwiftShader, against the run before | - | regression identical on every section (parity: `stacking` 0.06 -> 0.07) | no change | 2026-10-16 | - |
| fx harness, SwiftShader | - | all shots ok, 0.00 | no change | 2026-10-16 | - |
| `mutate-text` CPU p50 / p95, SwiftShader, n = 120, 1000x700 (scene / batches / cull) | 20.4 / 35.4 ms (14.3 / 10.1 / 3.2) with `--norefit` | 4.0 / 9.2 ms (0.2 / 0.0 / 0.5) | report | 2026-10-16 | `2026-10-16-swiftshader-refit.txt`, `-norefit.txt` |
| `test:edit`, M1 Pro | - | batches kept for all 10 moved edits; 0 px differ | 0 px | 2026-10-16 | `2026-10-16-m1pro-edit.txt` |
| `mutate-text` CPU p50, M1 Pro, headed, dpr 1, n = 400 (scene / batches / cull) | 15.6 ms with `--norefit`, same session (11.8 / 9.9 / 1.9); 11.8 ms in the edit-patch experiment | 1.9 ms (0.1 / 0.0 / 0.3) | at most 4 ms | 2026-10-16 | `2026-10-16-m1pro.txt`, `-norefit.txt` |
| `mutate-text` CPU p99 / max, same | 21.1 / 21.3 ms | 2.7 / 4.9 ms | p99 under 8 ms | 2026-10-16 | same |
| `mutate-text` frame interval p50 / p95, same | 16.9 / 24.1 ms | 16.7 / 17.5 ms | report | 2026-10-16 | same |
| `mutate-text` CPU p50 / p99, dpr 2 with the band | - | 1.8 / 2.3 ms | report | 2026-10-16 | `2026-10-16-m1pro-dpr2.txt` |
| `mutate-class` CPU p50 (moves nothing; unaffected) | 2.4 ms (`--norefit`) | 2.3 ms | no change | 2026-10-16 | `2026-10-16-m1pro.txt`, `-norefit.txt` |

Observations (SwiftShader):

- The first version kept the list for none of `mutate-text`'s swaps on
  `perf.html`. Two causes, both changed in the method:
  - Moved records were checked against each other's footprints from the
    last build: a swap that rewraps the paragraph moves its last word to
    the next line where the link's underline used to start, and the
    underline's new place was checked against the word's old one.
    Members now carry the refit that added them; all moved records' new
    footprints go in first, and a record's older footprints are skipped.
  - Whitespace glyphs had footprints. They paint nothing; they are now
    left out of batching footprints everywhere (`runFootprints`), which
    changes batch lists in general but not pixels (visual and fx
    harnesses unchanged).
- `cull` p95 (3.3 ms) is a swap that moves an instance to another y
  bucket: the layer's index is dropped and the next query walks.

Observations (M1 Pro):

- Every word swap kept its batch list: `batches` is 0.0 at p99, so no
  swap fell back to a rebuild. A word swap is now as cheap as a class
  toggle (1.9 against 2.3 ms); what is left is the subtree re-read
  (0.5 ms), the box and image upload (0.9-1.0 ms; text 0.1) and culling
  of the moved instances (0.3 ms).
- Without the refit, the frame interval's p95 was 24 ms (the 15.6 ms of
  CPU on top of the frame's other work); with it the swaps run at the
  page's 60 Hz pace.
- Visual and fx harnesses on the M1 Pro: output not saved to the
  evidence folder; the SwiftShader runs above show no change.

## Evaluation

Supported on both hypotheses. The existing batch list stays valid when
the moved records' new footprints are checked against the kept members
(10 of 10 moved edits in `test:edit`, every swap in `mutate-text`, 0 px
from a rebuild), and a word swap costs 1.9 ms of compositor CPU on the
M1 Pro at dpr 1 (threshold 4 ms; 15.6 ms without the refit in the same
session), with p99 2.7 ms (threshold 8 ms).

## Conclusion and next step

Known now: a batch list built greedily over the whole page can be kept
across an edit that moves records by checking only the moved records'
new footprints against the members kept from the build, provided a
moved record's own earlier footprints are ignored and records moved in
the same edit are checked against each other's new places. With the
culling bounds patched in place as well, an edit that moves text costs
time proportional to the edit (1.9 ms on a 4.8k-element page), like
one that moves nothing.

Next: the remaining ~1 ms of box and image upload per patched edit is
still a whole-buffer write; uploading only the replaced records' ranges
would take both kinds of edit near 1 ms. Not urgent.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
| Check each moved record against the members as built, inserting its new footprints after its check | First version | Blocked every `perf.html` swap: a rewrap moves a word to where another moved record (the link's underline) used to be, and the check saw that record's old footprint; replaced by inserting all new footprints first and skipping superseded ones | 2026-10-16 |
| Whitespace glyphs as footprints | Existing behaviour | A space's line box overlaps neighbouring decorations and blocked merges and refits for nothing; dropped from footprints | 2026-10-16 |
