# Experiment: morphing mirrored elements across a DOM swap

| Field | Value |
| --- | --- |
| Activity | C2 (the mirror's consistency across a swap; the morph look is X) |
| Status | Planned |
| Started | |
| Concluded | |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-26-morph-ghosts/` |

## Hurdle

`fx.morph` (M5) pairs elements by `data-gpu-morph` across two DOM states
and interpolates their records. The outgoing state's records are gone
after the swap's read, and the GPU data they reference (Slug bands in an
LRU, image atlas entries subject to eviction and repacking) can be
evicted or moved while the incoming page loads. The morph has to show
neither a half-built incoming mirror nor the source DOM, keep capture()
p95 at most 12 ms, and meet the M5 frame budget (gpu total p95 at most
1.5 ms above the running loop, 0 dropped at 120 Hz, M1 Pro, dpr 2).

## Why existing knowledge doesn't resolve it

The View Transitions API pairs elements by name but snapshots the
browser's paint as bitmaps (text scales as pixels; no glyph-level
morph) and runs no custom shader. `fx.transition`
(`2026-10-18-snapshot-transitions.md`) holds a viewport texture, not
records. FLIP libraries animate DOM boxes with transforms. None keeps
vector records of a page that no longer exists.

## Hypothesis

If capture() copies the keyed elements' records (plain data) into ghost
records frozen in viewport space and pins the Slug bands and atlas
entries they reference until end(), then ghosts can be drawn and
interpolated against the live incoming records through an extra layer,
with capture() under 12 ms and no frame over budget, because the copy is
proportional to the keyed records only and pinning only exempts entries
from eviction.

## Why the outcome is uncertain

Pins can starve the atlas or the band LRU on image-heavy swaps (an
eviction round may find nothing to drop); structural pairing of
descendants (walkRecords order) may mispair when subtrees differ; the
incoming read can rebuild the whole scene while ghosts draw.

## Method

To fill in before starting: a playground page with keyed headings,
images and cards across two layouts; `test/transition/run.ts`-style
swap timing; fx shots for progress 0 and 1 equal to each state exactly.

## Results

| Measure | Baseline | Result | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## Evaluation

## Conclusion and next step

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
| Per-element textures (View Transitions semantics) | Reuses isolate/transform | Rejected at planning (Q2): text blurs when scaled, no glyph morphs | 2026-10-26 |
