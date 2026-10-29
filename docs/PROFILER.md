# Profiler (M6): design

A first-class tool for answering **why did this site jank**, on any site
that mounts compositor-gpu. It grows out of what exists: the frame
profiler (`compositor.profile`: per-frame CPU phases, GPU per pass,
dropped frames with a blamed cause, long animation frames), the live HUD
(`profile.hud()`), the debug panel (`compositor-gpu/debug`) and the
site harness (`npm run test:site`, which injects the library into any
URL).

Everything shares one data model, the **recording**, and one viewer, so
a recording taken in the page, by the CLI or in CI opens the same way.

Status: 1 to 5 built 2026-10-28 (ROADMAP M6a to M6e). The
CLI is `npm run profile` (tools/profile.ts) rather than a package bin:
it runs from the source with tsx, like the bake tool. The panel puts the Frame view under the
Timeline rather than in a tab of its own.

## Pieces

### 1. Recorder core (`src/profile`)

- **Flight recorder.** While the devtools are mounted, the last 15 s are
  always kept in a ring (frames, long animation frames, marks, events),
  cheap enough to leave on. You see jank, then press **Save** (or
  `Shift+S`): the seconds before it become a recording. There's no need
  to be recording when the jank happens.
- **Explicit recordings**: `profile.start()` / `stop()` as now, plus
  `mark()` phases.
- **Richer frames.** Each frame says why it did what it did:
  - what invalidated the mirror: the mutation, resize, scroll, font or
    image load, with the elements involved (a selector path per element,
    capped);
  - what uploaded: atlas pages, images, vectors, textures, with byte
    counts;
  - which effects ran: passes, layers, materials and transitions, with
    GPU time by label;
  - the browser's own long animation frame (LoAF) work overlapping the
    frame: scripts with source, style/layout, render.
  - which opacity-group textures were drawn from a kept texture and
    which were rendered afresh, and why ('changed', 'moved',
    'transformed', 'leaf', a reason it can't be kept), with the first
    few elements (`FrameWhy.groups`; summed in the report as "group
    textures a frame").
- **Hitch explanations.** Today `blame()` returns one cause. Each dropped
  frame gets an ordered list of contributing factors with evidence (for
  example "read: partial, 412 elements, triggered by a class change on
  `.duo-stage`" or "script: `onScroll` in app.js, 18 ms"). The elements
  are linked back to the live page where possible.
- **Recording format v1**: versioned JSON (gzip on export). Contents:
  environment (UA, GPU adapter, dpr, viewport, refresh, options), frames,
  LoAFs, marks, hitches, and an optional filmstrip (small screenshots of
  the canvas around each hitch). It can be exported, imported and
  diffed.

### 2. DevTools tracks

The compositor's frames are written into Chrome's own Performance panel
as custom tracks, using `performance.measure` with the `detail.devtools`
extensibility API:

- a compositor CPU track (read, hooks, upload, encode per frame);
- a GPU track (passes at their measured duration);
- hitch markers with the explanation as tooltip.

These line up with the browser's main thread, layout and GC. The tracks
are on only while recording, or while the flight recorder runs with the
option set.

### 3. The GUI: `compositor-gpu/devtools`

A single panel, replacing `compositor-gpu/debug`'s corner panel. It lives
in a shadow root on `<html>` marked `data-gpu-ignore`, and is dockable at
the bottom or side. Tabs:

- **Live**: the HUD graphs, larger, plus the current numbers.
- **Timeline**: a recording (live, saved or imported).
  - Lanes for frames (interval, late frames red), compositor CPU phases,
    GPU passes, main-thread LoAFs and marks.
  - Hitch markers, zoom and pan.
  - The filmstrip above the lanes.
- **Frame**: the selected frame or hitch.
  - Its explanation and the work it did.
  - The elements involved. Hover outlines one on the page, and click
    selects it in the Elements tab.
- **Elements**: cost by element and by effect over the recording (reads,
  uploads, draws, GPU time), worst first.
- **Settings**: stats, dials, skeleton, scene reuse, flight recorder
  length, DevTools tracks. Persisted per site (localStorage), seeded from
  the URL (`?devtools=1`).

The viewer half (Timeline, Frame, Elements on a recording) is also built
as a standalone HTML page that opens a recording file, which the CLI uses
for its report. With the React provider, it is turned on with
`devtools={...}`.

### 4. CLI: `compositor-gpu profile <url>`

Built on the `test:site` injection (or `--bundle-url` for sites that
mount the library themselves).

- **Scenario.** It drives a real browser, headed on the real GPU by
  default, through a scenario: flags (`--scroll`, `--wait`, `--click
  <selector>`) or a scenario file (steps: scroll to, scroll by at a
  speed, hover, click, wait for a selector, `mark`).
- **Output.** It writes the recording, an HTML report (the standalone
  viewer) and a summary to stdout.
- **Budgets.** A budget file (dropped frames, p95 CPU/GPU, per-phase
  limits) gives a pass/fail exit code.
- **Baselines.** `--baseline <recording>` compares against a saved run.
- **Runs.** `--runs N` records the scenario N times, each in a fresh
  page, and prints a line per run. The report, the budget and
  `recording.cgprof` use the run nearest the median dropped frames, and
  each run is kept as `run-N.cgprof`. Against a baseline (a recording, or
  a profile-out directory, whose `run-N.cgprof` all count), each metric
  is the median, followed by every run's range and `within spread` when
  the two ranges overlap. On the M1 Pro, /duo at one build ranged from 67
  to 135 dropped frames run to run (2026-10-29), all from GPU time for
  the same passes, so compare 3–5 runs a side before believing a change
  under ~30 frames.

## Order

The main question is "why did it jank", so the order is:

1. **Recorder core**: flight recorder, attribution, hitch explanations,
   format v1, export/import. This is the data everything else shows.
2. **GUI**: Timeline and Frame on live and saved recordings, Settings
   (absorbing the debug panel), Live.
3. **DevTools tracks**.
4. **CLI** with scenarios, the HTML report and budgets.
5. **Elements tab** (cost ranking), filmstrip, baseline diff.

Each slice is usable on its own and leaves the existing API working:
`profile.start/stop/hud`, `compositor-gpu/debug` (kept as a thin alias)
and `test:profile`.

## Costs and limits

- The flight recorder and attribution have to stay off the hot path when
  not mounted. They are created only by the devtools or by `start()`.
  When on, they add at most 0.1 ms per frame (checked with `test:perf`).
- Element attribution is capped per frame: the first 32 elements, and
  counts beyond that.
- **LoAF is Chromium-only.** Safari and Firefox get compositor and GPU
  lanes but no script attribution, and hitches outside the compositor
  read "outside, no detail".
- **GPU timestamps** need `timestamp-query`. Without it the GPU lanes are
  absent; Safari only has it behind a flag.
- **Filmstrip capture** copies the canvas at hitches only, so it costs
  nothing between them.
