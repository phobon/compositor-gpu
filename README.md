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
npm run dev        # playground at / (a plain HTML page)
npm run typecheck  # tsc --noEmit
npm run build      # library build -> dist/
npm run lint       # biome
```

## Licence

MIT. The Slug port is derived from public-domain / MIT reference code — see
[`src/text/slug/README.md`](src/text/slug/README.md).
