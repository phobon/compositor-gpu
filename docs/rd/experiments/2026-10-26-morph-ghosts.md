# Experiment: morphing mirrored elements across a DOM swap

| Field | Value |
| --- | --- |
| Activity | C2 (the mirror's consistency across a swap; the morph look is X) |
| Status | In progress (built; M1 Pro measures pending) |
| Started | 2026-10-26 |
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

Built as `layoutMorph` (`src/fx/presets/layout_morph.ts`) with the
hybrid ghosts chosen with Ben (2026-10-26) in place of ghost records:
capture() measures the keyed elements' boxes (getBoundingClientRect,
the contents' box for an element that paints none) and holds the
viewport through `fx.transition`; nothing is copied or pinned. The old
element is cut from the held snapshot in the pass (a rounded rect, or
its text keyed out by its colour); the live element is carried by a
layer transform. Page `playground/layout.html` (heading, three cards
with image and title, grid <-> detail view, ten pairs including
nested ones); `window.__layout.results` collects capture() and
settled() times per swap; fx shots `fx-layout-0` / `-1` must equal
`fx-layout-a` / `-b` exactly.

## Results

| Measure | Baseline | Result | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| progress 0 vs state a, px differing (SwiftShader, headless; test:fx on the M1 Pro too) | | 0 | 0 | 2026-10-27 | |
| progress 1 vs state b, px differing (SwiftShader, headless) | | 0 | 0 | 2026-10-26 | |
| capture(), ms, max of 5 swaps (M1 Pro, `layout.html`, 10 pairs) | | 1.9 (0.6-1.9) | 12 | 2026-10-27 | `window.__layout.results` |
| settled(), ms, 5 swaps (M1 Pro) | | 14-28 (first 27.9) | | 2026-10-27 | `window.__layout.results` |
| gpu total p95 over the running loop, ms (M1 Pro, dpr 2) | | pending | 1.5 | | |

## Evaluation

capture() is far inside its budget because it copies nothing: it reads
the keyed elements' boxes and asks the transition for its snapshot.
settled() is one to two frames of mirror (about 14 ms at 120 Hz, more on
the first swap). Five swaps is a small sample; the gpu frame budget (p95
at most 1.5 ms over the running loop) is still to profile.

## Conclusion and next step

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
| Ghost records with Slug and atlas pins | The plan above | Replaced by snapshot cut-outs plus layer transforms (hybrid, chosen with Ben): no copies, no pins, the pass and core transforms already exist | 2026-10-26 |
| Pair table as one param per pair, read through generated switch functions | Params had no arrays | SwiftShader took minutes to compile the inlined switches; replaced by vec4 array params (`count`) | 2026-10-26 |
| Moving a text element by its border box | Simplest | A block heading's box spans the line, so the text stretched or did not scale; moved by its contents' box instead | 2026-10-26 |
| Old elements' spots blended to the snapshot background | Remove the old text | Left outlined residue at the glyph edges; the colour's share is subtracted instead (px − k (c − bg)) | 2026-10-26 |
| Per-element textures (View Transitions semantics) | Reuses isolate/transform | Rejected at planning (Q2): text blurs when scaled, no glyph morphs | 2026-10-26 |
