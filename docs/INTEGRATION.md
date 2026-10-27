# Integrating compositor-gpu (Gatsby / mds-home `/duo`)

`compositor-gpu` is framework-agnostic and **client-only**. In Gatsby it must
never run during SSR, so mount it after hydration inside `useEffect`.

## 1. Add as a submodule

From the mds-home repo root:

```bash
git submodule add https://github.com/phobon/compositor-gpu.git compositor-gpu
git submodule update --init --recursive
```

This mirrors the existing `MDS-web-ui` submodule pattern.

## 2. Wire the alias

Add to the `gatsby-plugin-alias-imports` block in `gatsby-config.js` (keep it in
sync with `jsconfig.json`, per the repo convention):

```js
alias: {
  // ...existing...
  'compositor-gpu': 'compositor-gpu/src'
}
```

`jsconfig.json`:

```json
"paths": {
  "compositor-gpu/*": ["compositor-gpu/src/*"]
}
```

Because we alias to `src`, Gatsby compiles the TS through its own pipeline — no
build step in the submodule is required for local dev. (For production you may
prefer consuming the built `dist/`; see below.)

## 3. Install peer deps in mds-home

```bash
yarn add typegpu opentype.js
```

## 4. Mount on `/duo`

`compositor-gpu/react` (React is an optional peer dependency) has a
client-only provider: it imports the library after mount, creates and
starts the compositor and the `/fx` runtime, and shares them with hooks
below it. SSR and browsers without WebGPU get the plain page.

```jsx
import { CompositorProvider, useFx } from 'compositor-gpu/react'

<CompositorProvider
  enabled={flag} // e.g. off with ?gpu=0
  options={{ mode: 'replace', fonts: 'auto', zIndex: 500 }}
  hud={false} // the profiler HUD
  trail={false} // true: one shared pointer trail (useTrail)
>
  {children}
</CompositorProvider>
```

Everything but `enabled` is read when the compositor is created. Hooks:
`useGpu()` (`{ compositor, fx, lib, trail, reducedMotion }`),
`useCompositor()`, `useFx()`, `useFxLib()` (the `/fx` module's presets),
`useTrail()`, all null until it runs; `useFxEffect(effect, deps)` and
`useElementFx(ref, effect, deps)`, a useEffect that waits for the
runtime and skips while the viewer asks for reduced motion
(`{ reducedMotion: true }` runs anyway); and hooks for presets:
`useSpotlight(ref)`, `useEdgeLens()`, `useTouchTrail()`. Their `bind`
option hooks the effect's `params`/`schema` up to a tuning panel.

With the alias above, `compositor-gpu/react` resolves to the submodule's
source, which imports `react` by name: it must resolve to the site's copy
(it does while the submodule has no `node_modules`; otherwise dedupe it,
e.g. vite `resolve.dedupe: ['react']`).

`compositor-gpu/dials` builds DialKit panels (an optional peer) from
effect schemas: `attachDials(panel, folder, { schema, targets, onChange,
actions })`, on with `?dials=1` (`configureDials` sets the parameter,
position, theme and inline/popover mode) or `setDialsShown(on)` at
runtime.

`compositor-gpu/debug` mounts a corner panel of debug toggles for a
compositor (stats HUD, dials, skeleton outlines), persisted in
localStorage and seeded from `?stats=1` / `?dials=1` / `?skeleton=1`:

```ts
const { mountDebugPanel } = await import('compositor-gpu/debug')
mountDebugPanel(compositor, { position: 'bottom-right' })
```

## Measuring parity on your site

`npm run test:site -- --url <url>` checks DOM-vs-GPU parity on a real page
without integrating anything first: it builds a self-contained bundle, injects
it, mounts a compositor, and screenshots DOM-only vs GPU-only at a few scroll
offsets (`--scroll 0,600,1200` by default). Useful flags: `--root "#app"` to
scope the mirrored subtree, `--only-layers boxes,text` to match your `layers`
option, `--replace` to test `mode: 'replace'`. It prints console
errors/warnings, uncaught exceptions, and any font faces that failed to
resolve — usually a CORS or 404 on an `@font-face` `url()`, since `fonts:
'auto'` fetches those from the page. If your CSP blocks the harness's own
injected `<script type="module">`, mount the library yourself (as above) and
run with `--bundle-url`, which skips injection and expects `window.__site` to
already hold your compositor.

## Notes
- Cross-origin images need CORS headers (`Access-Control-Allow-Origin`) to
  be drawn on the GPU. An `<img>` without them is left to the page: the
  compositor marks it `data-gpu-ignore="cross-origin"` and cuts a hole for
  it, and logs a warning. Background `url()`s without them are not drawn.
- `imageFadeIn: 250` (ms) fades images in when they arrive after the page
  is shown (after a route change, lazy loading) instead of popping in.
- Dynamic `import()` keeps TypeGPU/opentype out of the SSR bundle and off the
  critical path.
- WebGPU-absent browsers fall through to `passthrough` — the normal page
  (`compositor.active` is `false`, `compositor.canvas` is `null`).
- `compositor.stats()` returns live counts (`boxes`, `glyphs`, `draws`,
  `fps`, …) — wire it into a debug overlay behind the same flag.
- The submodule pins a commit; bump it with `git -C compositor-gpu pull` then
  commit the pointer in mds-home, exactly like `MDS-web-ui`.

## Baked assets (optional)

### Fonts

Instead of parsing each `@font-face` source in the browser (fetching the
font a second time and loading opentype.js), bake the faces the site uses
ahead of time and point the compositor at the manifest:

```jsonc
// compositor-gpu.bake.json
{
  "out": "public/gpu",
  "fonts": [{
    "file": "src/fonts/Inter.ttf", "family": "Inter",
    "weights": [400, 600], "opsz": [16, 32],
    "unicodeRange": "U+0020-007E, U+00A0-00FF, U+2010-2027"
  }]
}
```

`npm run bake -- compositor-gpu.bake.json` (in this repo) writes one `.cgf`
file per weight and optical size plus `manifest.json`; mount with
`options={{ ..., assets: '/gpu/manifest.json' }}`. Faces of a listed
family load their baked files when the page first uses the family; text
in a weight, optical size or character the files don't cover falls back
to the runtime path (that family's source is fetched and parsed then).
Baked text draws exactly as parsed text. Check the font's licence allows
converting it.

### Svg files as vectors

Svg files the site serves can be baked too, so an `<img>` of one draws as
vectors (sharp at any scale, and keyed morphs between them) instead of an
image:

```jsonc
{
  "out": "public/gpu",
  "svgs": [
    { "dir": "public/icons", "src": "/icons/" },   // every *.svg in it
    { "file": "public/logo.svg", "src": "/logo.svg" }
  ]
}
```

`src` is the URL pages load each file from. Mark the imgs with
`data-gpu-vector` (or `data-gpu-morph="key"` for layout morphs):

```html
<img src="/icons/star.svg" alt="" data-gpu-vector />
```

An opted-in img whose src the manifest lists draws from its baked file
(fetched when first needed; the img draws nothing until it arrives);
anything else draws as an image, as before. The bake skips a file it
can't draw as vectors (gradients, `<style>` rules, clip paths, masks,
filters, dashes, text, embedded images, group opacity, lengths in units
other than px) and says why. The img must use `object-fit: fill` (the
default).

## Note on `typegpu` and `process.env`

`typegpu` reads `globalThis.process.env.NODE_ENV` when it is first imported.
Bundlers replace the bare `process.env.NODE_ENV` form only, so in a browser
without a `process` global the import would throw. `compositor-gpu` installs a
minimal shim (`src/util/env.ts`) before importing `typegpu`, so importing
`compositor-gpu` first is enough; if your app imports `typegpu` directly
elsewhere, make sure `compositor-gpu` is imported before it.
