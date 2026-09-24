# compositor-gpu

Mirror a live web page onto the GPU — every box, image and glyph — kept in step
with the DOM and the CSS you already wrote, so you can run shaders over real,
accessible HTML. Text is painted from the font's own outlines with the **Slug**
algorithm: sharp at any size, no texture atlas, every letter individually
addressable.

> Status: **spec + scaffold**. The box pass is a complete vertical slice of the
> DOM→GPU sync loop; the Slug text pass is scaffolded end-to-end (CPU font
> pipeline + WGSL) and needs in-browser validation. See
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`ROADMAP.md`](ROADMAP.md).

## Why

The DOM stays the source of truth for **layout** — we never re-implement CSS,
line-breaking or shaping. The browser lays the page out invisibly; we read back
the resulting geometry and mirror it onto the GPU, kept in sync on scroll,
resize and mutation. The real DOM is still there, so accessibility, selection
and SEO are untouched, and if WebGPU is missing the page is simply itself.

## Install

```bash
npm install compositor-gpu
# peer runtime deps: typegpu, opentype.js
```

Requires **WebGPU** (Chrome/Edge 113+, Safari 18+, Firefox behind a flag).

## Quickstart

```ts
import { createCompositor } from 'compositor-gpu'

const compositor = await createCompositor({
  root: document.body,
  layers: ['boxes', 'images', 'text'],
  // move every letter independently, driven by time
  onGlyph: (g, ctx) => {
    g.offset.y = Math.sin(ctx.time / 300 + g.index) * 4
  }
})
compositor.start()
```

To render text you currently supply font bytes explicitly (runtime FontFace
byte-resolution is on the roadmap):

```ts
const bytes = await fetch('/fonts/Inter.ttf').then((r) => r.arrayBuffer())
compositor.text?.loadFontBuffer(bytes, 0)
```

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `root` | `document.body` | Subtree to mirror. |
| `mode` | `'overlay'` | `'overlay'` paints over the page; `'replace'` hides DOM paint (a11y kept). |
| `layers` | all | `'boxes' \| 'images' \| 'text'`. |
| `fallback` | `'passthrough'` | `'throw'` to hard-fail when WebGPU is absent. |
| `onGlyph` | — | Per-glyph hook each frame; mutate `glyph.offset`. |
| `onFrame` | — | Per-frame hook. |
| `debug` | `false` | Verbose logging. |

## Development

```bash
npm install
npm run dev        # playground on a local vite server (opens automatically)
npm run typecheck  # tsc --noEmit
npm run build      # library build -> dist/
npm run lint       # biome
```

### Playground

`npm run dev` serves `playground/` — a plain HTML page mirrored onto the GPU. A
control panel (top-right) shows live state: WebGPU on/off, box + glyph counts,
whether the font parsed, and fps. Three toggles:

- **GPU-only** — hides the DOM's own paint so you see *only* the GPU layer.
  Anything that vanishes wasn't mirrored. This is the box pass's A/B proof.
- **Animate letters** — drives every glyph's offset independently.
- **GPU layer on/off** — start/stop the compositor.

Shader-compile and GPU-validation errors are surfaced both in the console and in
the panel's red log area. Requires a WebGPU-capable browser (Chrome/Edge, or
Safari 18+).

The bundled `playground/font.ttf` is **Inter** (SIL Open Font License) — used to
feed real outlines to the Slug text pass.

## Licence

MIT. The Slug port is derived from public-domain / MIT reference code — see
[`src/text/slug/README.md`](src/text/slug/README.md).
