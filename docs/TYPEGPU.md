# TypeGPU for the shaders

The renderer's WGSL started as template strings (`/* wgsl */`) glued
together by interpolation (`${FRAME_WGSL}`, a material's `${wrap}`, preset
fragments pasted into pass templates). Each storage or uniform struct was
written twice, once in WGSL and once as the float offsets the JS packing
code writes, and kept in step by hand; a mismatch showed up only when a
pipeline compiled, or as wrong pixels. Shared helpers were pasted in as
text. This moves them onto TypeGPU (typegpu 0.12), one piece at a time,
without changing what any shader computes.

## The pattern

- **Data schemas are the one definition** of a buffer layout: `d.struct`
  for the WGSL struct, `d.sizeOf` for the buffer size, and
  `d.memoryLayoutOf(schema, (s) => s.field).offset` for the offsets the JS
  packing writes (`FRAME_AT` in `gpu/frame.ts`). `gpu/schema.ts` wraps
  these as `floatsOf(schema)` (the stride) and `floatOffsets(schema)`
  (each field's float offset), and `passExternals(layout, items)` builds
  a pass's externals: its structs and functions plus its layout's
  bindings.
- **Bindings come from a `tgpu.bindGroupLayout`** with a fixed `$idx`.
  A function that reads one names it as `L.$.entry` in its body and
  `.$uses({ L })`; resolution declares the binding (`@group(i)
  @binding(j) var ... entry`) under the entry's key.
- **Shared functions are `tgpu.fn`s** with WGSL bodies and `$name`s
  matching the names shaders already call, so the emitted WGSL is what the
  strings were.
- **Resolution pulls in only what is named.** `tgpu.resolve` follows the
  identifiers in its template (comments included) through `$uses`; an
  item nothing names isn't emitted. A pass's shader is a template
  resolved by `resolveShader(wgsl, externals)` (`gpu/frame.ts`), which
  adds the Frame items (`FRAME_EXTERNALS`) to the pass's own; a layout's
  bindings become externals under their own names through
  `bindingExternals(layout)` (getters, since `layout.$` exists only
  during resolution), so the WGSL says `frame.dpr`, not `L.$.frame.dpr`.
  Externals keep their `$name`s, so the template text is unchanged.
  `FRAME_WGSL`, the whole prelude as a string, stays for shaders written
  outside the library.

## Steps

Each is gated on `test:visual` and `test:fx` at 0.00 against goldens taken
before it, and no change in GPU time a frame or pipeline compile time.

1. **The shared Frame** (done, 2026-11-03): `FrameData`, `FrameClipData`,
   `frameLayout` (bind group 0) and `frame_clip_sd`, `frame_clip_cov`,
   `doc_to_clip`, `to_clip` in `gpu/frame.ts`. `FRAME_WGSL` is resolved
   from them (passes still prepend it), and `FRAME_BYTES`, `CLIP_FLOATS`
   and the renderer's Frame packing (`FRAME_AT`) come from the schemas.
   The GPU-side `GPUBindGroupLayout` is still made by hand in `Renderer`
   to match `frameLayout` (the GpuContext's root isn't typed as a
   `TgpuRoot` yet).
2. **Passes resolve their own shaders** (done, 2026-11-03): the record
   passes (through `PassPipelines`, which takes the pass's `externals`),
   cutouts, paths, the fallback-glyph atlas, the copy/clear passes, the
   group composite and the backdrop pass go through `resolveShader`
   instead of prepending `FRAME_WGSL`, so a pipeline gets only the Frame
   items it names (most drop `doc_to_clip`; copy and clear drop
   everything). The box shader takes `Box`, `boxes`, `stops`, `sd_box`
   and `edge_cov` as externals (`BOX_EXTERNALS`), images `sd_box`, and
   the `SD_BOX_WGSL`/`SD_EDGE_WGSL`/`BOX_DECLS` strings are gone. The
   fx passes still prepend `FRAME_WGSL` (step 5).
3. **Boxes** (done, 2026-11-03): `BoxData` (18 vec4s) and `boxLayout`
   (bind group 1: `boxes`, `stops`) in `boxes/box_data.ts`; the shader's
   struct and bindings are resolved from them (`BOX_DECLS`), and the
   instance packing writes each field at `BOX_AT[field]`, with the
   stride from `d.sizeOf`. `sd_round_box`, `sd_box` and `edge_cov` are
   `tgpu.fn`s in `gpu/sdf.ts`, replacing three pasted copies of
   `sd_round_box` and two of `edge_cov` (`SD_BOX_WGSL` for images,
   `SD_EDGE_WGSL` for boxes and cutouts). The shadow, gradient and
   dash helpers stay text in the box shader: nothing else uses them, so
   they can become `tgpu.fn`s now that the pass resolves its own
   shader.
4. **Text, images, paths** (done, 2026-11-04), and cutouts, the same
   way: `ImgData`/`imageLayout` (`images/image_data.ts`), `GlyphData`,
   `BandData`, `CurveData`/`slugLayout` and `QuadData`/`atlasLayout`
   (`text/glyph_data.ts`), `PathData`, `StrokeEdgeData`/`pathLayout`
   (`paths/path_layout.ts`), `CutData`/`cutLayout` (`boxes/box_data.ts`).
   Each shader's structs and bind group 1 come from them (layouts with
   textures and samplers included), and the packing writes named
   offsets (`IMG_AT`, `GLYPH_AT`, `QUAD_AT`, `CURVE_AT`, or a `put(field,
   ...)` over `PATH_AT`/`CUT_AT`). The resolved shaders match the
   strings they replace item for item. `SLUG_STRUCTS_WGSL`, for fx
   Layers that draw mirrored glyphs, is resolved from the schemas; the
   morph preset takes `GLYPH_FLOATS` from them but still reads glyph
   fields by literal offset in its WGSL (step 5). Slug's `Band` is one
   vec4 and is still packed by component.
5. **The fx passes and presets**, whose fragments already accept
   `tgpu.fn` (`src/fx/gpu.ts` externals): their templates and
   per-effect param blocks.
6. **Bind group layouts and the root**: type `GpuContext.root` as
   `TgpuRoot` and make the GPU layouts with `root.unwrap(layout)`.
