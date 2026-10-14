# Prior art

What existing solutions were checked for each hurdle, and why each doesn't
resolve it. Add an entry (from `templates/prior-art.md`) whenever something
new is checked. Entries marked **To verify** are from memory and need a
dated check with a link before the registration.

## html2canvas (and similar DOM-to-canvas renderers)

| Field | Value |
| --- | --- |
| Link | https://html2canvas.hertzen.com/ |
| Checked on | **To verify** |
| Checked by | |
| Relevant to | C1, C2 |

**What it does.** Walks the DOM and re-implements CSS rendering into a 2D
canvas to produce a screenshot.

**Why it doesn't resolve the hurdle.** One-off snapshot, not kept in sync;
re-implements layout and paint, so output diverges from the browser; not
real time; no GPU per-glyph access.

**What was taken from it.** Nothing.

## three.js CSS3DRenderer

| Field | Value |
| --- | --- |
| Link | https://threejs.org/docs/#examples/en/renderers/CSS3DRenderer |
| Checked on | **To verify** |
| Checked by | |
| Relevant to | C2 |

**What it does.** Positions real DOM elements in a 3D scene with CSS
transforms.

**Why it doesn't resolve the hurdle.** The browser still paints the elements;
shaders can't read or modify their pixels; no per-glyph geometry.

**What was taken from it.** Nothing.

## WICG HTML-in-Canvas proposal

| Field | Value |
| --- | --- |
| Link | https://github.com/WICG/html-in-canvas |
| Checked on | **To verify** (status changes; record the Chromium flag state on the check date) |
| Checked by | |
| Relevant to | C1, C2 |

**What it does.** Proposed API to draw DOM elements into a canvas (2D or
WebGPU texture), experimental in Chromium.

**Why it doesn't resolve the hurdle.** Not shipped and not cross-browser at
the check date; provides an element's pixels, not per-glyph geometry or
outlines, so per-letter effects aren't possible.

**What was taken from it.** Nothing.

## Slug algorithm reference code

| Field | Value |
| --- | --- |
| Link | See `src/text/slug/README.md` |
| Checked on | 2026-09-24 |
| Checked by | Ben McCormick |
| Relevant to | C3 |

**What it does.** GPU rendering of glyphs directly from quadratic outlines
with banded curve data.

**Why it doesn't resolve the hurdle.** Renders glyphs placed by the caller's
own text layout. Says nothing about matching a browser's placement, weight,
optical size or ligature handling when positions come from DOM rects.

**What was taken from it.** Reference shaders and band layout (MIT; patent
dedicated to the public domain March 2026). Porting is not claimed as R&D.

## Browser text geometry APIs (Range.getClientRects, measureText)

| Field | Value |
| --- | --- |
| Link | https://developer.mozilla.org/en-US/docs/Web/API/Range/getClientRects |
| Checked on | **To verify** |
| Checked by | |
| Relevant to | C1 |

**What it does.** Returns layout rects for a text range; Canvas 2D
`measureText` returns advance widths for a string in a given font.

**Why it doesn't resolve the hurdle.** Per-grapheme Range queries are too
slow on real pages (587 ms per full read on `perf.html`; Safari ~65x
Chrome). No spec guarantees canvas measurement matches DOM layout, which is
the question C1 tests.

**What was taken from it.** Both are the inputs C1 builds on.

## To add

- [ ] Search for other DOM-to-WebGPU or DOM-to-WebGL mirroring libraries and
      record what was found (or that nothing was).
- [ ] Search for published work on synchronising a script-driven canvas with
      compositor-thread scrolling.
