# Edit mode (spec; E1-E3 built)

A design-tool workflow for `/fx`: pick a composited element on the page,
attach effects to it with triggers, tune their params, and save the
result to a JSON file in the site repo that production loads. Decided
with Ben 2026-11-05:

- The saved config is a JSON file in the site repo, written from the
  browser (File System Access); the site imports it and
  `applyConfig(fx, config)` builds the effects. The file is the source of
  truth and diffs in git.
- Elements are matched by `data-fx="name"`, else by a generated
  selector, which the editor flags as fragile.
- Triggers animate with a small built-in tween in the config runtime
  (no GSAP/Motion needed for config-driven effects). This narrows the M4
  rule (timing comes from the page's library) to code-driven effects;
  code can still drive any param of a config effect.
- The editor is an `Edit` tab in `compositor-gpu/devtools`, so it works
  on any page that mounts devtools, `/duo` included.

Three parts, built in this order: the effect registry, the config runtime
(both in `/fx`, shipped to production), and the editor (devtools only).
The editor changes effects only through the runtime's `update()`, so
what you see while editing is what production runs.

## Config format

```jsonc
{
  "version": 1,
  "page": [                      // effects with no element (passes)
    { "id": "vig", "effect": "vignette",
      "params": { "amount": 0.4 }, "enabled": true, "triggers": [] }
  ],
  "elements": [
    {
      "match": { "fx": "hero" },           // or { "selector": "main > section:nth-child(2) img" }
      "effects": [
        {
          "id": "hero-light", "effect": "spotlight",
          "params": { "intensity": 0.2, "radius": 280 },
          "enabled": true,
          "triggers": [
            { "on": "pointerenter", "to": { "intensity": 0.6 },
              "duration": 0.3, "ease": [0.2, 0, 0, 1] },
            { "on": "pointerleave", "to": "rest", "duration": 0.5 }
          ]
        }
      ]
    }
  ]
}
```

- `params` are the rest values (what the effect shows with no trigger
  active). Omitted params take the effect's schema default.
- `id` is unique in the file; the runtime keys live handles by it.
- A selector matching several elements applies the effect to each
  (one handle per element); `data-fx` names may repeat for the same
  purpose.
- One file per page or route, chosen by the site. Breakpoints and
  per-route scoping inside one file are out of scope for v1.

### Triggers

`on`: `load`, `enter` / `exit` (viewport, IntersectionObserver with
`threshold`, `once`), `pointerenter`, `pointerleave`, `pointerdown`,
`pointerup`, `click`. Listeners go on the real DOM element: in replace
mode the source is hidden with `opacity: 0`, so it still gets pointer
events (hit-testing under GPU layer transforms is off near the edges, as
accepted 2026-10-08). Page effects take `load`, `enter`/`exit` of a named
element, and `click` anywhere.

Action, one of:

- `to`: param values to animate to, or `"rest"`.
- `enabled`: `true` / `false` (at once, or after the tween when both are
  given and it's `false`).
- `play`: `"forward"` / `"reverse"` / `"toggle"` for progress-based
  effects (motion, reveal, develop, dissolve, textStagger, morph): a
  tween of `progress` to 1 or 0.

Timing: `duration` (s), `delay` (s), `ease` (cubic-bezier array, or
`{ "spring": { "visualDuration": 0.4, "bounce": 0.2 } }`, the same
shapes `/dials` already edits). A trigger that fires mid-tween retargets
from the current values (springs keep their velocity). Under reduced
motion tweens land at once, as `motion.play()` does.

## Effect registry (`fx/registry.ts`)

The editor needs a list of effects with a uniform signature; the presets
today take `(fx, opts)`, `(fx, target, opts)` or `opts.target`.

```ts
registerEffect({
  id: 'spotlight',
  label: 'Spotlight',
  scope: 'element' | 'page',
  schema,                                  // ParamSchema + progress where it applies
  progress?: true,                         // drives `play`
  create(fx, el: Element | null, params) → { params, enabled, destroy() }
})
listEffects(): EffectDef[]
```

Every preset registers itself (one line next to its export). Sites
register their own effects the same way so they appear in the editor.
Writing WGSL in the editor is out of scope.

## Runtime (`fx/config.ts`)

```ts
const live = applyConfig(fx, config, { root?: ParentNode })
live.update(config)       // diff by id: same effect → assign params; else rebuild
live.fire(id, trigger)    // run a trigger by hand (editor preview, scripts)
live.get(id)              // the handles, for code that drives a config effect
live.resolve()            // re-match elements (after a route mounts content)
live.destroy()
```

- `update` with an equal config is a no-op, so an HMR reload of the JSON
  after the editor saves it doesn't rebuild anything.
- Elements that mount later: the site calls `resolve()`; a React hook
  `useFxConfig(config)` in `compositor-gpu/react` does it on mount.
- Composition with code-driven effects on the same element is the
  existing rule: transforms and motions combine into one layer
  transform; with two materials the later one wins.
- Inert without WebGPU (no listeners), and SSR-safe.

## Editor (devtools `Edit` tab)

Pick mode (`E` in the panel, or the tab's button):

- A fixed overlay marked `data-gpu-ignore` with a z-index above the
  canvas (so it gets no cutout) takes the pointer. Under it,
  `elementsFromPoint` finds the nearest candidate ancestor: named
  (`data-fx`), carrying a config effect, composited as a group (opacity,
  filter, blend, layer transform, region pass), under a material, an
  image/svg/canvas/video, or a text block. `[` / `]` or Alt+scroll walks
  up and down the ancestors; click selects; Escape leaves.
- Outlines come from Targets (`rect`, `space`), so drawing them reads no
  DOM per frame.
- Needs one new read-only core API, `graph.inspect()`: the scene's
  composited elements (groups with their element via `OpacityGroup.key`
  → `ElNode.el`, kind, bounds), materials with their targets, region
  passes and layer transforms, passes. The editor's layer list is built
  from it.

Panel:

- Left: a layer list: page effects, then elements with config effects,
  then other composited elements (dimmed). Selecting a row selects the
  element and scrolls it into view.
- Right: the selection: tag, `data-fx` or selector (with a "fragile"
  badge and a button copying `data-fx="…"` to paste into markup), what
  it composites as, its effects. Add effect (registry, filtered by
  scope); per effect: enabled, a param form from the schema (sliders,
  colour, vectors; plain DOM controls in the devtools' `h()`, not
  DialKit, which is an optional peer), and its triggers (add, edit,
  reorder, a button firing each one).
- Undo / redo over config snapshots (Cmd+Z in the tab).

Saving:

- "Open config…" / "Save as…" (`showOpenFilePicker` /
  `showSaveFilePicker`). The `FileSystemFileHandle` is kept in IndexedDB,
  so after a reload one click re-grants write permission.
- Autosave 300 ms after the last change, with a dirty marker; a draft is
  also kept in localStorage (`compositor-gpu:edit-draft`) until the file
  write succeeds.
- Without File System Access (Safari, Firefox): download / upload JSON.
- The editor loads the file it saves; on open it diffs the file against
  the page's applied config and offers to take either.

## Milestones

- E1: registry (all presets), config format and `applyConfig` /
  `update` / `fire`, triggers and the tween. `npm run test:unit`:
  diffing, trigger state, tween and spring retargeting. `test:fx` shots
  `fx-config` (a config equals the same effects built in code exactly)
  and `fx-config-then-off`.
- E2: `graph.inspect()`, pick mode, layer list, read-only inspector.
- E3: adding and removing effects, param and trigger editing through
  `update()`, undo.
- E4: saving (File System Access, IndexedDB handle, autosave, fallback).
- E5: on `/duo`, move one existing reveal from code to a config file;
  `useFxConfig`.

## Deviations (E1)

- Presets are listed in `fx/builtin_effects.ts`, not registered from
  each preset file: with `"sideEffects"` limited to `util/env.ts`, a
  bundler drops a preset module whose only use is registering itself.
  The registry imports that list, so using `applyConfig` bundles every
  listed preset. Each listed preset now exports its `schema`.
- Not listed: `gallery`, `morph`, `layoutMorph`, `radialReveal`,
  `touchTrail` (they take inputs beyond params). Region-capable passes
  (`blur`, `progressiveBlur`, `displace`, `rgbSplit`, `glitchSlices`,
  `lens`) take both scopes: fullscreen on the page, a region pass on an
  element. `shockwave` is the one impulse effect (`play` calls its
  `play()` at the click point, else the element).
- `motion` wraps `fx.motion` with flat params `from.x` .. `to.opacity`
  (x, y, scale, rotate, opacity) and `progress`; its own ease stays
  linear and the trigger's timing eases `progress`.
- Options that aren't params (`rgbSplit`/`lens` `followPointer`,
  `cursorGlow` `place`, `spotlight` `kinds`) keep their defaults.
- `update()` resets only effects whose entry changed: their instances
  go back to rest, triggers are rebound and `load` triggers run again.
  Params the new entry leaves unset return to the effect's own
  defaults (taken right after creation, so preset option defaults that
  differ from schema defaults hold). A changed `effect` or scope
  rebuilds.
- A trigger's `play` with `toggle` starts from the end nearer the rest
  `progress`.
- Colours in a config are hex strings or [r, g, b, a] (sRGB, 0..1).
- Region passes on one element no longer clobber each other: the
  runtime gives the graph the latest created enabled one
  (`isolateRegion` in `fx/effects.ts`). Before, turning off one region
  pass released the element from all of them (`fx-config` caught it:
  the code-built reveal, switched off, removed the config's). Only one
  still draws; chaining them is an open question.

## Deviations (E2)

- `graph.inspect()` returns `InspectedElement`s (`el`, `kinds`:
  opacity, filter, blend, region, transform, material; `alpha`,
  material labels, `depth`) from the current scene's groups and the
  registered materials. Cutouts and plain records aren't listed.
- The devtools find configs through `liveConfigs()` (`fx/config.ts`);
  a LiveConfig also has `instances()` and `version`. The Edit tab loads
  `fx/config` by dynamic import on first show, so the devtools bundle
  doesn't carry the effects until then.
- Outlines use `getBoundingClientRect`, like the devtools' other
  outlines, on scroll, resize and a 500 ms refresh, not Targets: the
  tab may show elements that have none.
- Candidates while picking: `data-fx`, a config effect, an inspected
  element, img/svg/canvas/video/picture, or an element with its own
  text; `[` / `]` or Alt+wheel walk ancestors from there. Shift-click
  keeps picking.
- The inspector already fires triggers (planned for E3), from the rest
  values (`live.fire(id, n, { fromRest: true })`), so a `play forward`
  that already ran plays again.
- Materials that aren't active (disabled) are left out of `inspect()`.
- The outlines and the pick overlay sit at z-index 2147483646, the
  playground canvas's: a page whose canvas is mounted after the
  devtools at that z-index would cover them.
- `playground/fx.html` (not `?vr`) applies a demo config: the displace
  section's heading reveals on load, its image develops back on hover.

## Deviations (E3)

- Edits are pure functions over FxConfig (`devtools/edit_model.ts`:
  addEffect, removeEffect, setParam, setEnabled, setTrigger, uniqueId)
  applied with `live.update()`; `History` keeps whole configs (100
  steps), and changes to one param within 1.5 s (a slider drag) are one
  step. Undo / redo: buttons, ⌘Z / ⇧⌘Z / Ctrl+Y in the tab.
- `update()` retunes in place when only an effect's `params` changed:
  the rest values that changed are written, the others (a played
  `progress`) stay, and triggers aren't rebound or `load` run again.
- New effects get the id `<suggested name>-<effect>` (page effects:
  the effect id), made unique; an element without `data-fx` is matched
  by its generated selector.
- Controls (`devtools/edit_form.ts`): f32 slider and number (range from
  the schema, else from the default), vector fields, colour picker with
  alpha (saved as `#rrggbb[aa]`), a reset per set param, the live
  value beside it. Triggers: event, action (to / rest / play / none),
  `to` as JSON, enabled, ease (named curves or spring), duration or
  settle and bounce, delay, target (a bare name is a data-fx name),
  once. `threshold` and custom bezier values are kept but not editable.
- The inspector isn't rebuilt while focus is inside it, so a drag or a
  typed value isn't interrupted; live values update in place.
- With no config on the page, Start a config applies an empty one to
  `createEffects(compositor)`. Copy config puts the JSON on the
  clipboard until E4 saves it.
- Several configs on a page: a picker chooses which one is edited.

## Open questions

- Several region passes on one element (a blur and a reveal on the
  same card) drawn as a chain rather than the latest one alone.

- Per-breakpoint params (`@media` keys on `params`)?
- Should a selected element without `data-fx` get one written into
  the source by a dev-server endpoint, rather than copied by hand?
- Scroll-scrubbed triggers (`progress` bound to scroll through an
  element) — the GSAP recipe covers it today; a `scroll` trigger would
  make it editable.
