# Lazy reads: design

A read of the DOM costs about 40 µs an element, almost all of it computed
style (2026-10-29: ~95 property reads an element at ~0.4 µs each; the
largest single sinks are the background/border records, text runs and
pseudo-elements, none above a quarter). A full or escalated read walks the
whole document, though only the canvas region (the viewport plus
`canvasMargin` above and below) is ever drawn. On the marketplace's
Templates page that is ~1,080 elements and 38–45 ms on a route change
(an M1 Pro), most of them screens away. Reading per element faster has
given ~15% (the border and pseudo-element fast paths); reading fewer
elements is the remaining order of magnitude.

## Goal

A read walks only the subtrees that can paint near the canvas. A subtree
far from it is **deferred**: its root element is read as now (its own
records, rect, clip, context), its children are not. As the canvas moves
towards a deferred subtree, the compositor reads it, a few at a time,
before it can reach the canvas. Nothing drawn changes; only when the DOM
is read does.

Target: a route change on a long page reads what is within about two
viewports of the screen (marketplace Templates: ~1,080 → ~250 elements,
45 → ~10 ms), and scrolling into deferred content costs at most a couple
of milliseconds a frame.

## The read window

`W` is the canvas region grown by `lazyMargin` (default one viewport
height) above and below, in document space. An element's children are
deferred when:

- its border box, grown by its own ink (shadows, outline, filter extents,
  from the records it just produced), lies outside `W` by at least
  `lazySafe` (default one viewport height): far, not just outside;
- it is in document space (not in a `position: fixed` subtree), not
  sticky, not the root, and its subtree isn't isolated for a region
  effect or held as an opacity group;
- no element in its subtree can be `position: fixed` (see below);
- it doesn't carry `data-gpu-eager`.

Its `ElNode` gets `deferred: true` and no kids. Everything else about the
node is as now: its rect is the partial-read escalation check, its
records draw (they're far away, so they're culled anyway).

A child of a read element that lies far outside the window itself is
cheaper still: a **stub** node of its rect (one `getBoundingClientRect`)
and three style reads (`display`, `position`, `float`), with no records,
read in full like any deferred node when the canvas nears. A grid of
cards far down the page costs a rect read a card instead of ~40 µs an
element under it. Stubs are skipped (read in full) for fixed, sticky,
floated, inline and `display: contents` elements, opted-out ones, ones
isolated or held as groups, and any that can hold a fixed element.

## What could paint far from its ancestor

Deferring assumes a subtree paints near its root's box. What breaks that:

- **`position: fixed` descendants** without a trapping ancestor inside
  the subtree. They appear in the viewport wherever their parent is (a
  fixed nav inside a static `<header>` that has scrolled screens away).
  Guarded: like `PseudoRules`, a scan of the document's style rules
  collects the selectors of every rule setting `position: fixed`, plus
  `[style*="fixed" i]` for inline styles. A root whose subtree matches
  one (`el.querySelector(list)`, one native call) isn't deferred. Nested
  rules are resolved against their parent (`&` as `:is(parent)`). An
  unreadable sheet (cross-origin), or a rule nested under a
  pseudo-element, turns lazy reads off.
- **Absolute positioning against a containing block outside the
  subtree**, and **large transforms**, can move content more than
  `lazySafe` away. Not detectable cheaply; `lazySafe` is the margin for
  it, and `data-gpu-eager` the opt-out for a subtree that does.
- **Text and counters** are unaffected: list ordinals and generated
  counters are computed from the DOM, not from the read tree.

## Reading as the canvas moves

Each frame the canvas or `W` moved (a scroll, a re-anchor), the reader
walks its deferred roots (kept in a list with their doc rects: no DOM
access) and queues those now inside `W`, nearest the viewport first. The
compositor issues them as partial-read scopes, within a budget of
`lazyBudget` ms a frame (default 2). A deferred root that the *canvas*
reaches before it's read is read that frame regardless of budget, so
what's drawn is never missing content. Fast flings may pay a long read
then; the margin makes that rare.

A partial read of a deferred root is the ordinary partial read: its
rect is checked against the stored one (escalating if it moved), its
subtree is read under the current window (so its own far descendants
can stay deferred), and the scene is patched or rebuilt. A mutation
inside a deferred subtree scopes to the deferred root and is ignored
until it's read (its rect still triggers escalation if layout moved).

## As built (2026-10-29)

- `SceneReader.readWindow` (set by the compositor each frame from the
  scroll: canvas margin plus `lazyMargin`), `defers()` and `farStub()`
  in `dom/tree.ts`, `dueDeferred()` for the compositor; fixed-position
  selectors from `dom/pseudo_rules.ts` (`mayHoldFixed`).
- The compositor (`lazyScopes`) queues due nodes as partial-read scopes:
  all that the canvas reaches, then nearest first within `lazyBudget`
  (estimated from the subtree's element count and the measured cost per
  element), always at least one a frame, at most 32; it asks for another
  frame while any are due.
- Headless (a 1,100 px viewport over a 400-card grid, a numbered list,
  a fixed nav inside a static header): a full read at the top 3,268 →
  529 elements, 200 → 61 ms; at the bottom 3,260 → 339, 214 → 32 ms;
  scrolling in 260 px steps reads 8–16 elements a frame;
  pixel-identical to an eager read at every step, after editing,
  restyling and removing far content, and after jumping back to the
  top. The whole of test:visual and test:edit with `lazyRead` forced
  on: unchanged.

- 2026-10-29, first desktop runs: both sites' sheets hold nested rules
  (Panda's empty `:root { & [data-theme] {} }`, a nested rule in /duo's
  commons.css), which the first scan gave up on, so lazy reads never
  engaged. The scan now resolves nesting; in the browser it finds both
  sites' fixed rules (`.pos_fixed`; /duo's ScrollTop and nprogress) and
  misses no element with a fixed position or pseudo-element content.

## What else changes

- `ElNode.deferred`, `SceneReader.deferred` (roots and rects), and the
  window passed into `readNode`.
- `stats().deferred` (roots and the elements under them) and the
  profiler: `FrameWhy` notes lazy reads; the report counts them apart
  from mutation reads.
- The fill planner needs nothing new: a lazily read subtree changes the
  scene like any partial read.
- `CompositorOptions.lazyRead` (default `false` at first), `lazyMargin`,
  `lazySafe`, `lazyBudget`.

## Testing

- Visual parity: test:visual at scroll offsets with `lazyRead` on must
  equal it off, and a page that scrolls through deferred content frame
  by frame must equal a full read at each step.
- A fixed element inside a far `<header>`, an `<ol>` across deferred
  items, a deferred subtree mutated then scrolled to.
- test:edit (partial reads), test:fx at scroll.
- Desktop: /duo and the marketplace scenario with `lazyRead: true`,
  against runs without.

## Rollout

Opt in per site first (`lazyRead: true` in marketplace's and /duo's
options), measured with the profiler scenarios; default on once both
hold up.
