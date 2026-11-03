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
  packing writes (`FRAME_AT` in `gpu/frame.ts`).
- **Bindings come from a `tgpu.bindGroupLayout`** with a fixed `$idx`.
  A function that reads one names it as `L.$.entry` in its body and
  `.$uses({ L })`; resolution declares the binding (`@group(i)
  @binding(j) var ... entry`) under the entry's key.
- **Shared functions are `tgpu.fn`s** with WGSL bodies and `$name`s
  matching the names shaders already call, so the emitted WGSL is what the
  strings were.
- **Resolution pulls in only what is named.** `tgpu.resolve` follows the
  identifiers in its template (comments included) through `$uses`; an
  item nothing names isn't emitted. A prelude still used as a string
  (`FRAME_WGSL`) is a `tgpu['~unstable'].declare` whose text names every
  item it should carry.

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
2. **Passes resolve their own shaders** with the frame items as
   externals instead of prepending `FRAME_WGSL`, so each pipeline gets
   only what it uses.
3. **Boxes**: the `Box` struct (17 vec4s, the largest) as a schema the
   instance packing writes through, `sd_box` / `edge_cov` and the shadow
   helpers as `tgpu.fn`s.
4. **Text, images, paths** the same way.
5. **The fx passes and presets**, whose fragments already accept
   `tgpu.fn` (`src/fx/gpu.ts` externals): their templates and
   per-effect param blocks.
6. **Bind group layouts and the root**: type `GpuContext.root` as
   `TgpuRoot` and make the GPU layouts with `root.unwrap(layout)`.
