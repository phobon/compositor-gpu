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

A client-only React wrapper (`src/components/Duo/GpuCompositor.jsx`) creates the
compositor after mount, behind a flag so it's opt-in and easy to A/B:

```jsx
import { useEffect } from 'react'

export const GpuCompositor = ({ enabled = false, onGlyph }) => {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    let compositor
    let cancelled = false
    import('compositor-gpu').then(async ({ createCompositor }) => {
      compositor = await createCompositor({
        mode: 'overlay', // 'replace' also opacity-hides the DOM's own paint
        layers: ['boxes', 'text'],
        fonts: 'auto', // discovers document.fonts; pass FontFace[] to scope it
        onGlyph
      })
      if (cancelled) return compositor.destroy()
      compositor.start()
    })
    return () => {
      cancelled = true
      compositor?.destroy()
    }
  }, [enabled, onGlyph])
  return null
}
```

Enable it with `?gpu=1` (see the drop-in on `/duo`), so the default page is
untouched and turning the flag off leaves it pixel-identical.

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
- Dynamic `import()` keeps TypeGPU/opentype out of the SSR bundle and off the
  critical path.
- WebGPU-absent browsers fall through to `passthrough` — the normal page
  (`compositor.active` is `false`, `compositor.canvas` is `null`).
- `compositor.stats()` returns live counts (`boxes`, `glyphs`, `draws`,
  `fps`, …) — wire it into a debug overlay behind the same flag.
- The submodule pins a commit; bump it with `git -C compositor-gpu pull` then
  commit the pointer in mds-home, exactly like `MDS-web-ui`.

## Note on `typegpu` and `process.env`

`typegpu` reads `globalThis.process.env.NODE_ENV` when it is first imported.
Bundlers replace the bare `process.env.NODE_ENV` form only, so in a browser
without a `process` global the import would throw. `compositor-gpu` installs a
minimal shim (`src/util/env.ts`) before importing `typegpu`, so importing
`compositor-gpu` first is enough; if your app imports `typegpu` directly
elsewhere, make sure `compositor-gpu` is imported before it.
