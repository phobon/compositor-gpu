# Experiment: transitions between two DOM states through a held snapshot

| Field | Value |
| --- | --- |
| Activity | C2 (to confirm: the consistency of the mirror across a DOM swap is C2; the transition shaders themselves are X) |
| Status | Planned |
| Started | 2026-10-18 |
| Concluded | |
| People | Ben McCormick; Claude (Anthropic) as coding assistant |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-18-snapshot-transitions/` |

## Hurdle

A page transition of the kind in the reference video (a circular reveal
from the cursor, a white bloom, a lens into a gallery) needs the
outgoing page and the incoming page on screen at once, blended by a
shader. The compositor mirrors one DOM: once the site swaps routes, the
outgoing page no longer exists to read. The new page's mirror is also not
complete when the DOM changes: its full read, font resolution, image
decodes and material compiles take frames to tens of frames (the
replace-mode handoff waits up to 1500 ms for the same reasons). A
transition has to show neither a half-built new page nor the source DOM
painting through the canvas, and has to keep 120 Hz on an M1 Pro at dpr
2, where a frame that redraws the band already takes ~7 ms of the
8.33 ms budget (`2026-10-16-gpu-headroom.md`) and frames are never
skipped while a post chain runs (`2026-10-16-skip-unchanged.md`).

## Why existing knowledge doesn't resolve it

The View Transitions API does this for the browser's own paint
(snapshots of the old and new states, cross-faded by the compositor),
but it captures the DOM's paint, not this canvas, and its pseudo-element
animations can't run a custom shader. WebGL page-transition libraries
(Barba.js with a three.js scene, curtains.js) render each page's images
as textures they own, not a mirror of the whole page that has to become
complete again after the swap. Inside this library, the replace-mode
handoff (`compositor.ts`, `handoffAt`) knows when a fresh mirror is
complete, but only once at start; nothing holds the previous frame while
a later DOM swap rebuilds the scene, and the post chain reads the
current scene texture only.

## Hypothesis

With `fx.transition({ fragment, params })`: `capture()` copies the
visible viewport of what the canvas last showed (the kept texture, or
the post chain's scene texture) into a held texture, the transition's
pass draws only that texture until the new mirror is complete (the
handoff's test: fonts resolved, no image pass upload pending, no
material compiling, no viewport `<img>` loading), then resolves
`settled`, and the site tweens `params.progress` from 0 to 1 while the
pass blends `prev(uv)` and `sample(uv)`; at 1 the pass is disabled and
the texture released. Then on the M1 Pro, headed, dpr 2, a new
`playground/transition.html` (two page states with fonts and images,
swapped by script, 20 transitions of 600 ms each, both directions):

1. No frame between `capture()` and `settled` shows anything but the
   held snapshot, and no frame of the transition shows the source DOM
   (a probe counts frames where a mirrored element without the hidden
   attribute is painted): 0 such frames.
2. `capture()` to `settled` p95 at most 250 ms on a page of the
   playground's size (most of it the new page's full read and image
   decodes).
3. During the 600 ms of progress: 0 frames dropped at 120 Hz, frame
   interval p95 at most 9.3 ms, `gpu total` p95 at most 7 ms.
4. fx harness: a transition held at progress 0 equals a capture of the
   outgoing state exactly; at progress 1, and after it ends, equals the
   incoming state with no pass exactly.

## Why the outcome is uncertain

- The swap and the new page's first full read may land in a task that
  also paints: replace mode hides mirrored source elements through
  `reconcileHidden` on childList records, which run after the browser
  may already have painted the inserted nodes once.
- A full read of a page the playground's size takes tens of ms on the
  M1 Pro; it stalls the main thread, and whether the held frame stays
  on screen through that stall (no `getCurrentTexture` meanwhile) or
  the canvas tears or flashes during a resize of the document isn't
  known. The new page's document height differs, so the canvas
  re-anchors and may be resized in the same frame.
- The scroll resets to 0 on the new page while the snapshot is
  viewport-fixed; the page-anchored canvas moves with the scroll, so the
  held texture has to be placed against the viewport, not the canvas.
- A transition frame draws the band, copies it into the scene texture,
  and runs a fullscreen pass sampling two textures: whether that fits in
  7 ms at dpr 2 isn't known (the band alone is ~7 ms when it redraws;
  `skipUnchanged` doesn't apply while the chain runs).
- Image decodes for the incoming page may never finish (a lazy image
  below the fold, a broken URL); `settled` needs a timeout, and a
  transition that starts on it shows a partial page.

## Method

1. `gpu/graph.ts`: a held texture the renderer fills from its post
   input on request (`graph.snapshot()`), placed against the viewport;
   `/fx`: `fx.transition()` built on a fullscreen pass with a `prev`
   binding (as `image` binds an image record), `capture()`, `settled`
   (the handoff's completeness test, factored out of `compositor.ts`,
   with a timeout), `end()`.
2. `playground/transition.html`: two states (text, a webfont, six
   images), Next / Prev buttons, a circular reveal from the pointer as
   the transition shader; `?auto` runs the 20 transitions for the
   profile and reports `capture()` → `settled` times and probe counts.
3. `test/profile/run.ts --url .../transition.html?auto` on the M1 Pro,
   headed, dpr 2; the fx harness shots `fx-transition-0`,
   `fx-transition-half`, `fx-transition-1`.
4. Baseline: the same page swapping states with no transition (the
   frames dropped and the time until the new page is complete).

## Results

| Measure | Baseline | Result | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## Evaluation

## Conclusion and next step

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
| | | | |
