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
      compositor = await createCompositor({ layers: ['boxes', 'text'], onGlyph })
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

## Notes
- Dynamic `import()` keeps TypeGPU/opentype out of the SSR bundle and off the
  critical path.
- WebGPU-absent browsers fall through to `passthrough` — the normal page.
- The submodule pins a commit; bump it with `git -C compositor-gpu pull` then
  commit the pointer in mds-home, exactly like `MDS-web-ui`.
