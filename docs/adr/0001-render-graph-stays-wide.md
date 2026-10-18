# 0001: RenderGraph stays one wide interface with one adapter

Date: 2026-10-18. Status: accepted.

## Context

`RenderGraph` (`src/gpu/graph.ts`) is the only way `/fx` reaches the
core: 16 methods plus `shared` and `version`, implemented once by the
object literal in `compositor.ts`. An architecture review proposed
narrowing it into role-shaped ports that return fx-shaped views, and
adding a null adapter so the inert runtime (no WebGPU) could run the
real effect code instead of the inert twins (`inertLayer`,
`inertMaterial`, `inertTrail`, `inertEffects().pass`).

## Decision

Keep the interface as it is. Don't add a null adapter.

## Reasons

- A null graph can't replace the inert twins. Passes, layers and
  materials build their own buffers, pipelines and bind groups on
  `graph.shared.device`; without WebGPU there is no device, so their real
  constructors can't run behind a null graph. Doing it properly means
  putting all of `/fx`'s GPU work behind the seam, a redesign of `/fx`.
- The members that look like leaks are what the seam is for.
  `glyphTable()` lets a layer draw glyph coverage from the Slug outline
  buffers, `imageOf()` lets it sample a page image from the atlas without
  a copy, `nodeOf()` gives targets an element's runs. Wrapping them adds
  a copy or an indirection on per-frame paths, for no second consumer.
- What the null adapter was meant to fix is already fixed: since
  `fx/lifecycle.ts`, the inert twins share the real handles' lifecycle
  (`enabled`, `continuous`, params, destroy) and their `continuous`
  defaults, so they no longer drift.
- The `graph: null` branches it would remove are about six checks in
  `fx/target.ts` and `fx/compose.ts`.

## Revisit when

`/fx` gains a second runtime (a WebGL fallback, or rendering in a
worker), or a consumer other than `/fx` needs the graph: then there
would be two adapters and a real seam to shape.
