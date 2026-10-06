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
- **Bands**: the em box is sliced into 16 horizontal (row) bands, then 16
  vertical (column) bands whose curves are stored x/y-swapped; each band lists
  the quads crossing it. This is Slug's acceleration structure — a pixel only
  tests the curves in its bands.
- **GPU buffers** (`rasterizer.ts`): `bands` (vec4f per band: yMin, yMax,
  curveStart, curveEnd) and `curves` (vec4f p0.xy/p1.xy + vec4f c.xy) are built
  once per font; `glyphs` holds one instance per on-screen glyph.

## Shader (`shaders.ts`)
Per pixel (`slug_coverage`): transform to em space and cast a horizontal ray
through the row band holding `em.y` and a vertical one through the column band
holding `em.x`, each as two rays a quarter pixel either side of the centre.
Each ray sums signed sub-pixel coverage from its curve crossings; the two
directions are blended by their weights (Slug's), and `SLUG_GAMMA` (0.87)
thickens edges toward Chrome's weight.

`prepare()` resolves each `FontFace`'s `@font-face` `url()` and fetches the
bytes at runtime (`text/fontSource.ts`); it is not a stub.

## Remaining gaps
1. **`calt`/`dlig`** — contextual alternates and discretionary ligatures
   aren't applied (only `liga`/`clig`, e.g. Inter's arrow ligatures fall
   through unmerged).
2. **Combining sequences** — multi-code-point grapheme clusters Slug can't
   shape itself fall back to the Canvas 2D atlas rather than being drawn as
   composed Slug outlines.
3. **Paint order within a batch** — `draw()` always issues the Slug pipeline
   before the atlas pipeline for a batch's glyph range, so an atlas
   (fallback) glyph always paints over a Slug glyph in the same batch
   regardless of each glyph's actual `z` order.
