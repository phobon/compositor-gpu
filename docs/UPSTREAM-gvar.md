# Draft upstream issue for opentypejs/opentype.js

Status check (2026-09-30): no existing issue or PR found with this diagnosis.
Searches only turned up #754 (variable fonts rendering wrongly in 2.0.0), which
has no diagnosis and may or may not share this cause. The repro below has not
been run against the live Inter download.

Below the rule is the issue text.
---

**Title:** gvar: packed point count 0 ("all points") is handled as "no points", so tuples with all points use the shared point list

**Version:** opentype.js 2.0.0 (npm, `dist/opentype.mjs`)

## Description

OpenType spec, "Packed point numbers"
(https://learn.microsoft.com/en-us/typography/opentype/spec/otvarcommonformats#packed-point-numbers):

> If the first byte is 0, then a second count byte is not used. This value has
> a special meaning: the tuple variation data provides deltas for all glyph
> points (including the "phantom" points), or for all CVTs.

`Parser.prototype.parsePackedPointNumbers` returns `[]` for a count of 0. That
is also what the parser uses for "no private points, use the shared ones", so
two places get it wrong:

1. `parseTupleVariationStore`, in `parseDeltas`:
   `pointsCount = header.privatePoints.length || sharedPoints.length`.
   A tuple with private points and count 0 gets `sharedPoints.length` as its
   delta count; the all-points fallback (`glyph.points.length + 4`) runs only if
   the shared list is empty too. Too few x deltas are read and the y deltas
   start in the middle of the x data.
2. `applyTupleVariationStore`:
   `tuplePoints = header.privatePoints.length ? header.privatePoints : sharedPoints`.
   The tuple is applied to the shared point indices instead of every point.

It only shows when a glyph has a non-empty shared point list and a tuple with
private points and count 0. Glyphs without a shared list work.

## Symptom
Inter Variable (https://rsms.me/inter/): D, R and similar glyphs are mangled at
any non-default weight. Some points get other points' deltas, the rest do not
move. The default instance and other glyphs are fine.

## Repro

```js
import { parse } from 'opentype.js'

// Download the variable TTF from https://rsms.me/inter/ and serve it locally.
const font = parse(await (await fetch('/InterVariable.ttf')).arrayBuffer())

const g = font.charToGlyph('D')
g.path // parse the glyph so g.points is populated
const store = font.tables.gvar.glyphVariations[g.index]
for (const h of store.headers) {
  console.log(h.privatePoints.length, store.sharedPoints.length,
    h.deltas.length, g.points.length + 4)
}
// Rows with privatePoints.length 0 and sharedPoints.length > 0 print
// deltas.length === sharedPoints.length instead of g.points.length + 4.
// Drawing D and R after font.variation.set({ wght: 700 }) shows broken outlines.
```

## Fix

Keep "all points" distinct from "not present" (`parser.js`, then
`applyTupleVariationStore`):

```diff
 Parser.prototype.parsePackedPointNumbers = function() {
   const countByte1 = this.parseByte();
+  if (countByte1 === 0) return null;   // all points incl. phantoms
   const points = [];
```

```diff
-    header.privatePoints = [];
+    header.privatePoints = undefined;   // undefined: use shared; null: all
 ...
-      pointsCount = header.privatePoints.length || sharedPoints.length;
-      if (!pointsCount) {
+      const pts = header.privatePoints === undefined
+        ? sharedPoints : header.privatePoints;
+      if (pts === null) {
         const glyph = glyphs.get(glyphIndex);
         glyph.path;
-        pointsCount = glyph.points.length;
-        pointsCount += 4;
+        pointsCount = glyph.points.length + 4;
+      } else {
+        pointsCount = pts.length;
       }
```

```diff
-      const tuplePoints = header.privatePoints.length ? header.privatePoints : sharedPoints;
+      let tuplePoints = header.privatePoints === undefined
+        ? sharedPoints : header.privatePoints;
+      if (tuplePoints === null) {
+        tuplePoints = Array.from({ length: points.length }, (_, i) => i);
+      }
```

`sharedPoints` needs the same `null` handling. `points` already includes the
four phantom points. Callers reading `privatePoints`/`sharedPoints` would see
`null`/`undefined` where they saw `[]`; a lazily materialised `[0 .. n-1]` array
avoids that (lazy because `glyph.points` exists only after the glyph parse).

## Workaround
We patch the prototype at startup: `parsePackedPointNumbers` returns a lazily
filled `[0 .. glyph.points.length + 3]` when the result is empty (about 100
lines, `src/text/slug/gvarFix.ts` in our repo).

## Offer
I can send a PR with this fix and a test using a small variable font that has a
shared point list and an all-points tuple on one glyph. Tell me whether you
prefer the `null` sentinel or a materialised array. Possibly related: #754.
