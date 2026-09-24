import type { Scene } from '../scene/scene'

/** WGSL shared by every pass: the per-frame uniforms + doc->clip transform. */
export const FRAME_WGSL = /* wgsl */ `
struct Frame {
  viewport : vec2f,   // CSS px size of the mirrored viewport
  scroll   : vec2f,   // document scroll offset (CSS px)
  time     : f32,     // ms since load
  dpr      : f32,
  _pad     : vec2f,
};
@group(0) @binding(0) var<uniform> frame : Frame;

// Document space (CSS px from doc top-left) -> WebGPU clip space.
fn doc_to_clip(p : vec2f) -> vec4f {
  let v = (p - frame.scroll) / frame.viewport;
  return vec4f(v.x * 2.0 - 1.0, 1.0 - v.y * 2.0, 0.0, 1.0);
}
`

/** Bytes in the Frame uniform block (2+2+1+1+2 floats = 8 floats). */
export const FRAME_BYTES = 8 * 4

/** A render pass owns one pipeline + its instance buffers for one layer. */
export interface RenderPass {
  readonly layer: 'boxes' | 'images' | 'text'
  /** Re-pack instance buffers from the (dirty) scene. */
  upload(scene: Scene): void
  /** Record draw calls into an open render pass encoder. */
  draw(encoder: GPURenderPassEncoder): void
  destroy(): void
}

/** Resources every pass shares: the device, target format, and frame uniforms. */
export interface Shared {
  device: GPUDevice
  format: GPUTextureFormat
  frameLayout: GPUBindGroupLayout
  frameBindGroup: GPUBindGroup
}
