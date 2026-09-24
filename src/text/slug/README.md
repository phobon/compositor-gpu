# Slug text backend

Atlas-free GPU glyph rendering: each glyph is one instanced quad, painted from
the font's own Bézier outlines. Sharp at any size, no texture atlas, every
letter individually addressable.

## Provenance & licence
Adapted from Eric Lengyel's **Slug** reference shaders. The Slug patent
(US 10,373,352) was dedicated to the public domain in March 2026 and the
reference code is MIT-licensed, so this port carries no IP encumbrance. See
https://terathon.com/blog/decade-slug.html and https://sluglibrary.com/.

## Data layout
- **Outline extraction** (`font.ts`): opentype.js parses the font; each glyph's
  path is flattened to **quadratic** Béziers in normalised em space (cubics are
  reduced via a midpoint split — scaffold-grade; the reference uses a tighter
  reduction).
- **Bands**: the em box is sliced into 16 horizontal bands; each band lists the
  quads crossing it. This is Slug's acceleration structure — a pixel only tests
  the curves in its band.
- **GPU buffers** (`rasterizer.ts`): `bands` (vec4f per band: yMin, yMax,
  curveStart, curveEnd) and `curves` (vec4f p0.xy/p1.xy + vec4f c.xy) are built
  once per font; `glyphs` holds one instance per on-screen glyph.

## Shader (`shaders.ts`)
Per pixel: transform to em space, pick the band by `em.y`, walk that band's
curves, accumulate a winding number from scanline crossings to the right, and
convert to coverage.

## Remaining work (v1)
1. **Analytic anti-aliasing** — replace the nonzero hard coverage with the
   reference's sub-pixel coverage (horizontal distance to each crossing).
2. **Font byte resolution** — `prepare()` should fetch a `FontFace`'s source and
   call `loadFontBuffer`; today the caller supplies bytes explicitly.
3. **Real cmap + shaping ids** — `glyphId` currently carries a code point; wire
   it to the browser-shaped glyph indices for ligatures/contextual forms.
4. **On-demand glyph upload** — build band/curve data lazily per glyph instead
   of a fixed code-point set, with an LRU.
5. **In-browser validation** — the shader has never executed (no WebGPU in the
   build sandbox); expect to debug winding sign + band selection first.
