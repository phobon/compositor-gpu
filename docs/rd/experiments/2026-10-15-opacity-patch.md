# Experiment: opacity edits without a scene rebuild

| Field | Value |
| --- | --- |
| Activity | C2 (low-latency DOM-to-GPU synchronisation at pixel parity; partial reads) |
| Status | Concluded (hypothesis 1 supported; hypothesis 2 met for the GPU, CPU 0.3 ms over its threshold) |
| Started | 2026-10-15 |
| Concluded | 2026-10-16 |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-15-opacity-patch/` |

## Hurdle

A style-driven fade of 16-48 elements on `perf.html` (n = 400) runs at
~26 fps on an M1 Pro: every frame costs ~33 ms of compositor CPU, of
which ~10 ms is a scene rebuild and ~17 ms a full re-pack of the text
buffer, and the GPU frame doubles (13.2 against 6.7 ms) because each
rebuild is a new batch list (`2026-10-15-many-groups.md`). The groups
themselves cost under a millisecond. The rebuild happens because a
partial read that contains a stacking context can't be patched
(`dom/patch.ts`), and every faded element is one.

## Why existing knowledge doesn't resolve it

The edit patch (`2026-10-14-edit-patch.md`) replaces records in place
when a re-read subtree has the same records, but it gives up on any
stacking context because paint order and groups depend on more than the
records' place in the tree. Whether contexts can be matched one to one
between two reads (same structure, only alphas changed) and the groups
updated in place without visible change is not established. Browsers
avoid the problem by compositing opacity on a separate layer tree with
its own property updates; this compositor has no such tree, only the
records, groups and batches built from a read.

A second part is open too: an element crossing opacity 1 changes the
structure (a context appears or disappears), which no in-place patch can
cover. Keeping such an element a group for a while at opacity 1 keeps
the structure stable, but a group at opacity 1 paints in context order,
not tree order, and costs a group pass while it lasts.

## Hypothesis

1. A partial read whose subtrees keep the same records and the same
   stacking contexts (count, z, own records; no region, filter, blend
   group or isolation), changing only opacities, can be applied by
   replacing the records in place and setting the matching groups'
   alpha, with the visual, fx and edit harnesses unchanged (edit
   harness: 0 px between patched and rebuilt canvases).
2. With elements that were below opacity 1 in the last second kept as
   groups at opacity 1 (released by one re-read when the hold ends),
   `fade` on `perf.html` (48 elements, n = 400, M1 Pro, headed, dpr 2,
   band, `--nodim`) costs at most 4 ms of compositor CPU per frame
   (p50; 32.4 ms before), and its GPU total p50 is within 1 ms of the
   `groups` scenario's.

## Why the outcome is uncertain

- The subtree re-read itself (boundaries are the faded elements'
  parents: cards and lists) may stay a large part of the frame even
  without the rebuild.
- Patched text runs are re-packed run by run; 48 elements' runs may
  still be a sizeable upload.
- The renderer and the batch builder may hold state derived from the
  groups (packing, bounds, cull caches) that an alpha change in place
  leaves stale.
- Releasing many holds at once costs one rebuild; whether that lands as
  a visible hitch after the animation is unknown.

## Method

1. `dom/patch.ts`: `subtreeRecords` also returns the subtree's stacking
   contexts in tree order and accepts plain ones; `patchScene` requires
   the same contexts on both sides and sets each group's alpha (groups
   carry their context's node as a key). `dom/tree.ts`: an element below
   opacity 1 is held as a group at alpha 1 (`ElNode.holdGroup`) until
   1 s after the latest read that saw any element below 1, and always
   through the next read after its own; all holds end together, and
   `SceneReader.expiredHolds()` has the compositor re-read the held
   elements once then (a timer wakes the loop). `CompositorOptions.patchOpacity` (default true)
   for the A/B; `perf.html?nopatchopacity`, `test:profile
   --nopatchopacity`.
2. Checks: visual, fx and edit harnesses (SwiftShader).
3. Measures: `pnpm test:profile -- --headed --dpr 2 --band --nodim --only
   scroll,groups,fade`, with and without `--nopatchopacity`, same
   session. `stats().patchedReads`.

## Results

| Measure | Baseline | Result | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| Edit harness: patched vs rebuilt canvas, with three opacity edits added (new groups, new alphas, one back to 1 in a held group) | - | 0 px differ; both opacity edits patched (19 of 21 reads patched) | 0 px | 2026-10-15 | (harness output, `test:edit`) |
| Visual harness, SwiftShader | regression column of the run before | identical on every section | no change | 2026-10-15 | - |
| fx harness, SwiftShader, against goldens from the code before | - | 0.00 on every shot | no change | 2026-10-15 | - |
| `fade` compositor CPU p50 / p95, SwiftShader, n = 120, 1000x700, `--nopatchopacity` | - | 31.3 / 65.0 ms (read 16.0, scene 12.3; upload 11.5, text 10.5) | report | 2026-10-15 | `2026-10-15-swiftshader-nopatch.txt` |
| Same, patched, hold 600 s for the software frames (6 of 6 fade frames patched) | 31.3 / 65.0 ms | 6.5 / 14.0 ms (read 3.0, scene 0.2; upload 1.5, text 0.2; encode 0.9) | report | 2026-10-15 | `2026-10-15-swiftshader-patch-longhold.txt` |
| `fade` compositor CPU p50 / p95, 48 elements, M1 Pro, headed, dpr 2, band, `--nodim` | 36.4 / 41.2 ms (`--nopatchopacity`, same session) | 4.3 / 5.7 ms (read 2.2, scene 0.1; upload 1.5, text 0.2; encode 0.2; other 0.6) | p50 at most 4 ms | 2026-10-16 | `2026-10-15-m1pro.txt`, `2026-10-15-m1pro-nopatch.txt` |
| `fade` p99 / max CPU (the frame that first puts the 48 elements below 1: a rebuild, as expected) | 44.4 ms | 42.0 ms | report | 2026-10-16 | same |
| `fade` frame interval | ~42 ms (78 frames over 3.3 s; no frame paced) | 16.7 / 17.5 ms p50 / p95 (78 frames over 1.3 s), 0 dropped | report | 2026-10-16 | same |
| `fade` GPU total p50 against `groups` GPU total p50 (same run) | 11.05 against 8.23 ms | 6.76 against 8.28 ms | within 1 ms | 2026-10-16 | same |
| `groups`: frames dropped / partial reads (entering and leaving 48 groups) | 9 / 2 | 4 / 3 | report | 2026-10-16 | same |

Observations (SwiftShader):

- With a per-element 1 s hold, most fade frames still rebuilt in the
  sandbox: software frames take ~4.5 s, so an element's hold had ended
  by the next read (`2026-10-15-swiftshader-patch-1s.txt`). That showed
  two things the method then changed: a hold must last at least through
  the next read whatever the frame time, and per-element hold ends of a
  staggered fade would each force a rebuild, one every couple of frames,
  after the fade. Holds now end together, 1 s after the latest element
  was below 1, with one re-read.

Observations (M1 Pro):

- All 78 fade frames were partial reads and all but the first were
  patched (scene 0.1 ms p50, text re-pack 0.2 ms): the per-frame rebuild
  is gone. The fade now runs at the page's 60 Hz pace (16.7 ms between
  frames) instead of ~24 fps.
- The GPU no longer doubles during the fade (6.8 ms against 11.1 ms
  without the patch), since the batch list and cull cache survive a
  patch: this confirms the cause guessed in `2026-10-15-many-groups.md`.
- What is left per frame: the re-read of the faded elements' parents'
  subtrees (2.2 ms), the record upload (1.5 ms, boxes and images; text
  0.2) and 0.6 ms other.
- The re-read that releases the holds 1 s after the fade fell outside
  the recording, so its cost wasn't measured here. Leaving the
  `groups` scenario (all 48 back to 1 at once, a rebuild) still costs
  one 41 ms frame.
- Visual, fx and edit harnesses on the M1 Pro: all passed (reported by
  Ben McCormick, 2026-10-16; output not saved to the evidence folder).

## Evaluation

Hypothesis 1 is supported: opacity-only partial reads are applied in
place (all fade frames after the first), and the edit, visual and fx
harnesses show no change, in SwiftShader and on the M1 Pro.

Hypothesis 2 is met for the GPU (6.8 ms, below the `groups` frame) and
missed for the CPU by 0.3 ms: 4.3 ms p50 against a 4 ms threshold, an
8.5x reduction from 36.4 ms in the same session. The fade no longer
drops below the page's frame rate.

## Conclusion and next step

Known now: stacking contexts can be matched between two reads and their
groups updated in place, so an opacity animation costs a subtree re-read
and an upload, not a scene rebuild; holding faded elements as groups for
a second keeps a fade's end from changing the structure. A style-driven
fade of 48 elements on a 4.8k-element page went from ~24 fps to the
display's pace, 4.3 ms of compositor CPU per frame.

Next, if the remaining 4.3 ms matters: skip re-reading a subtree whose
only change is its root's opacity (read the one computed value, keep the
records), and upload only the replaced records' ranges of the box and
image buffers. Also measure the hold-release frame after a fade.

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
| Per-element 1 s holds | First version | Ended between reads on slow (software) frames, and would release a staggered fade's holds one by one, each a rebuild; replaced by one shared end and a hold through the next read | 2026-10-15 |
