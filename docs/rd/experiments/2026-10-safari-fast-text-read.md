# Experiment: FAST_TEXT_READ on WebKit

| Field | Value |
| --- | --- |
| Activity | C1 |
| Status | Planned |
| Started | |
| Concluded | |
| People | Ben McCormick |
| Related commits | |
| Evidence folder | `docs/rd/evidence/2026-10-safari-fast-text-read/` |

## Hurdle

Safari's full read on bonobolabs.com `/duo` was ~65x Chrome's (steady frame
49 ms vs 0.7 ms) because each grapheme needs a `Range` rect query.
`FAST_TEXT_READ` cut Range queries 84k -> 15k in Chrome, but has not been
measured in Safari.

## Why existing knowledge doesn't resolve it

No documentation states whether WebKit's Canvas 2D `measureText` widths
match its DOM text layout. Chrome's results don't transfer: the two are
separate code paths in each engine. See `prior-art.md` (browser text
geometry APIs).

## Hypothesis

In Safari, Canvas 2D suffix widths match DOM layout within 0.05 px for
Latin text without ligature candidates, so at least 80% of graphemes on
`/duo` and `perf.html` take the fast path and the full read drops by at
least 50% against `FAST_TEXT_READ` off.

## Why the outcome is uncertain

WebKit may round text advances differently in canvas and layout, apply
different optical-size or hinting choices, or report rects at a different
precision. If widths don't match, every chunk falls back per grapheme and
each font gives up after 8 misses, so Safari sees no gain.

## Method

1. Baseline: Safari, `/duo?gpu=1&stats=1`, `FAST_TEXT_READ` off; record
   `stats().textRead` and read time at three scroll offsets.
2. Same with `FAST_TEXT_READ` on.
3. Repeat on `playground/perf.html` (`npm run test:profile -- --headed` or
   manual).
4. If the fast path fails, log the mismatch size per font and size to find
   the cause.
5. Hardware: Ben's Mac (record model, macOS and Safari versions).

## Results

| Measure | Baseline | Result | Threshold | Run date | Evidence file |
| --- | --- | --- | --- | --- | --- |
| Fast-path share of graphemes (`/duo`) | | | >= 80% | | |
| Full read time (`/duo`) | | | -50% | | |
| Range queries per full read (`perf.html`) | | | | | |

## Evaluation

## Conclusion and next step

## Alternatives tried or rejected

| Approach | Why tried | Outcome | Date |
| --- | --- | --- | --- |
| | | | |
