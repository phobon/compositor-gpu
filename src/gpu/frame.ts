import type { Scene } from '../scene/scene'

/** WGSL shared by every pass: the per-frame uniforms + doc->clip transform. */
export const FRAME_WGSL = /* wgsl */ `
struct Frame {
  viewport : vec2f,   // CSS px size of the mirrored viewport
  scroll   : vec2f,   // document scroll offset (CSS px)
  time     : f32,     // ms since load
  dpr      : f32,
  vscroll  : vec2f,   // offset subtracted from viewport-space positions
};
@group(0) @binding(0) var<uniform> frame : Frame;

// Document space (CSS px from doc top-left) -> WebGPU clip space.
fn doc_to_clip(p : vec2f) -> vec4f {
  let v = (p - frame.scroll) / frame.viewport;
  return vec4f(v.x * 2.0 - 1.0, 1.0 - v.y * 2.0, 0.0, 1.0);
}

// A record's position -> clip space. space < 0.5: document space (minus
// frame.scroll); otherwise viewport space (position: fixed subtrees), minus
// frame.vscroll — 0 on the canvas, the target origin's viewport position
// on an opacity-group target.
fn to_clip(p : vec2f, space : f32) -> vec4f {
  let o = select(frame.scroll, frame.vscroll, space > 0.5);
  let v = (p - o) / frame.viewport;
  return vec4f(v.x * 2.0 - 1.0, 1.0 - v.y * 2.0, 0.0, 1.0);
}
`

/** Bytes in the Frame uniform block (2+2+1+1+2 floats = 8 floats):
 * viewport, scroll, time, dpr, vscroll. */
export const FRAME_BYTES = 8 * 4

/** A render pass owns one pipeline + its instance buffers for one layer. */
export interface RenderPass {
  readonly layer: 'boxes' | 'images' | 'text'
  /** Re-pack instance buffers from the (dirty) scene. */
  upload(scene: Scene): void
  /**
   * Draw instances [first, first + count) of this layer, in scene order.
   * Called once per draw batch (Scene.batches); the renderer interleaves
   * layers so paint order holds across boxes/images/text. Returns the
   * number of `encoder.draw` calls issued (the `draws` stat) — a pass may
   * collapse several instances into one draw (e.g. atlas-backed images).
   */
  draw(encoder: GPURenderPassEncoder, first: number, count: number): number
  destroy(): void
}

/** Resources every pass shares: the device, target format, and frame uniforms. */
export interface Shared {
  device: GPUDevice
  format: GPUTextureFormat
  frameLayout: GPUBindGroupLayout
  frameBindGroup: GPUBindGroup
  /** Device pixel ratio of the current frame (set by Renderer.render). */
  dpr: number
}
