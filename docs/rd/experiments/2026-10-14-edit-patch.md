# Experiment: patching the scene in place for an edit

| Field | Value |
| --- | --- |
| Activity | C2 (low-latency DOM-to-GPU synchronisation; partial reads, result 2) |
| Status | Concluded (supported) |
| Started | 2026-10-14 |
| Concluded | 2026-10-14 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-14-edit-patch/` |

## Hurdle

A one-word edit on `perf.html` costs 31.3 ms of CPU per frame on an M1
Pro, 86% of it rebuilding the whole scene (10.5 ms, batches 7.6 ms) and
re-packing all text (16.3 ms); reading the edited card is 0.6 ms
(`2026-10-14-edit-cost.md`). The cost follows the page, not the edit.

## Why existing knowledge doesn't resolve it

Incremental scene updates are standard in retained-mode renderers, but
here every record carries global state: a paint index (`z`) assigned by
a walk of the whole stacking tree, a position in its layer's instance
buffer, membership in cross-layer batches chosen by overlap tests,
opacity-group bounds, clip-shape indices and material tags, and the
text pass's glyph cache slots are pinned per frame. Which edits can be
applied without recomputing those, and whether the checks that decide
it cost less than the rebuild they skip, isn't known in advance.

## Hypothesis

When an edit leaves the re-read subtree's records the same in number,
kind, order, material, space, clip and per-run glyph and shadow counts,
and the subtree holds no stacking context, replacing the records where
they sit (keeping their paint indices and buffer positions), rebuilding
batches only when their geometry changed (not the paint order), and
re-packing only the changed text runs gives:

1. pixel-identical output to a full rebuild after a series of edits;
2. on the M1 Pro, `mutate-class` (a class toggle, geometry unchanged) at
   most 4 ms CPU per edit p50, and `mutate-text` (a word swap, glyphs
   move) at most 12 ms p50, against ~31 ms now.

## Why the outcome is uncertain

- The glyph cache evicts least-recently-used slots; re-packing only some
  runs doesn't mark the others' slots as used, so an eviction during a
  partial pack could leave unchanged glyphs pointing at a reused slot.
  The partial pack has to detect that and fall back.
- Edits that move glyphs still need new batches (overlap tests use
  glyph rects), the largest single cost; the text-edit target depends
  on what remains after skipping the rest.
- Effects keyed to records (materials, image regions, glyph tables) see
  new record objects without a full rebuild; anything that caches on
  record identity must notice.
- The checks themselves walk the subtree twice; on a large subtree they
  may approach the cost they save.

## Method

1. `dom/tree.ts`: after a partial read, compare each boundary's old and
   new records (flatten order); if every boundary passes, `Scene.patch`
   replaces them in place (copying `z`), bumps `scene.version`, marks the
   box/image/cutout layers dirty (full upload, ~1 ms) and the changed
   text runs; batches are rebuilt from the current order only if some
   record's geometry changed, and the whole read falls back to the
   rebuild if any check fails. `stats().patchedReads` counts patches.
2. `text/slug/rasterizer.ts`: a patch re-packs only the changed runs and
   writes their instance ranges; any eviction or atlas reset during it,
   or a mismatch in counts, falls back to the full pack.
3. Check: a new equivalence test makes edits with patching on, captures
   the canvas, forces a full read, captures again and compares (0
   pixels differ), plus the visual and fx harnesses.
4. Measures: `test:profile --only mutate-class,mutate-text --nodim`
   (scenarios split from `mutate`), M1 Pro and SwiftShader, before
   (patching off via `?nopatch`) and after.

## Results

| Measure | Before (rebuild) | After (patch) | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| Patched vs rebuilt canvas after 18 edits (`test:edit`), SwiftShader | - | 17 of 18 reads patched, 0 px differ | 0 px | 2026-10-14 | `2026-10-14-swiftshader.txt` |
| Visual / fx harness failures, SwiftShader | 5 / fx-trail*, fx-displace*, fx-dissolve | the same, same numbers | no new failures | 2026-10-14 | same |
| CPU per edit p50, SwiftShader, `mutate-class` (read / scene / upload / text / cull) | 170.1 (66.7 / 63.0 / 51.9 / 44.8 / 10.5) ms | 16.0 (3.7 / 0.3 / 12.2 / 0.3 / 0.0) ms | - | 2026-10-14 | same |
| Patched vs rebuilt canvas (`test:edit --headed`), M1 Pro | - | 17 of 18 patched, 0 px differ | 0 px | 2026-10-14 | `2026-10-14-m1pro-run1.txt` |
| CPU per read p50, M1 Pro, run 1 (no net change per read, see observations): `mutate-class` / `mutate-text` | 32.0 / 31.2 ms | 2.4 / 2.0 ms | - | 2026-10-14 | same |
| CPU per edit p50, M1 Pro, run 2 (one edit per read): `mutate-class` / `mutate-text` | 32.0 / 31.2 ms (run 1) | 2.3 / 11.8 ms | 4 / 12 ms | 2026-10-14 | `2026-10-14-m1pro-run2.txt` |
| `mutate-text` p50 breakdown, M1 Pro: read (scene, batches) / upload (text) / encode (cull) | 11.4 (11.0, 8.0) / 17.4 (16.3) / 1.8 (1.7) ms | 8.6 (8.3, 6.6) / 0.9 (0.1) / 2.2 (2.1) ms | - | 2026-10-14 | same |
| `mutate-text` p99 / max, M1 Pro | 38.7 ms max (run 1) | 19.1 / 20.6 ms | - | 2026-10-14 | same |

Observations so far:

- The one read not patched in `test:edit` is the longer word (glyph
  count changes), as designed; the read after it patches again.
- In SwiftShader a frame takes seconds, so `mutate-text`'s two swaps
  land in one read and cancel out (checked with a temporary log: no
  geometry change); its SwiftShader numbers don't measure a moved-glyph
  edit. `test:edit`'s heading and word swaps do move glyphs and match
  the rebuild.
- Run 1 on the M1 Pro: `mutate-class` and `mutate-text` made an edit
  every frame, and the scenario's rAF callback runs before the
  compositor's, so each read saw two toggles and no net change. The
  rebuild path costs the same either way (32 ms); the patch path ran
  but never had moved glyphs to rebatch, so its 2.0 ms for text is not
  a word-swap measurement. The scenarios now edit every other frame;
  in SwiftShader `mutate-text` then rebuilds batches on every read
  (batches 29.9 ms there), as expected. The earlier `mutate` scenario
  alternated kinds, so each of its reads saw one class and one text
  change; its numbers stand.
- In the patched `mutate-class` frames, the remaining upload (12.2 ms in
  SwiftShader) is the box and image layers, still packed in full; text
  is 0.3 ms.

## Evaluation

Supported. Patched edits draw the same pixels as a rebuild (0 px over 18
edits, M1 Pro and SwiftShader), and on the M1 Pro a class toggle costs
2.3 ms (from 32.0) and a word swap 11.8 ms (from 31.2), inside both
thresholds; the word swap only narrowly, and its slow tail (p99 19 ms)
is over a 60 Hz frame. What remains in a word swap is rebuilding
batches (6.6 ms), the rest of the batch step (1.7 ms: material tags and
per-run rect unions over the whole page) and the cull recompute the new
batches cause (2.1 ms), all still proportional to the page.

## Conclusion and next step

Known now: a partial read can be applied to the GPU scene in time
proportional to the edit when the edit keeps the scene's structure,
which covers class and style changes and same-length text; checking
that costs well under a millisecond. Edits that move glyphs still pay
for page-wide batching.

Next, if text edits matter on the sites: keep batches across a moved
edit when its new footprints don't change any overlap decision (or
rebuild only the batches it touches), and update the cull bounds for
the replaced records instead of rebuilding them, which together would
take a word swap to ~2 ms.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
