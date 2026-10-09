import type { Scene } from '../scene/scene'
import type { Layer } from '../types'
import type { MaterialBinding } from './material'

/** WGSL shared by every pass: the per-frame uniforms + doc->clip transform. */
export const FRAME_WGSL = /* wgsl */ `
struct Frame {
  viewport : vec2f,   // CSS px size of the target (canvas or group texture)
  scroll   : vec2f,   // doc-space origin of the target (CSS px)
  time     : f32,     // ms since load
  dpr      : f32,
  vscroll  : vec2f,   // offset subtracted from viewport-space positions
};
@group(0) @binding(0) var<uniform> frame : Frame;

// Exact clip shapes (Scene.clipShapes; index 0 = none): a clipping
// ancestor's padding box in its local frame, for rounded or rotated clips.
struct FrameClip {
  inv0 : vec4f,   // a, b, c, d: record space -> local, linear part
  inv1 : vec4f,   // e, f (translation), w, h (padding box size)
  rx   : vec4f,   // inner radii tl, tr, br, bl (horizontal)
  ry   : vec4f,   // vertical
};
@group(0) @binding(1) var<storage, read> frame_clips : array<FrameClip>;

// Signed distance to a rounded rect centred at 0 (half size: half), per
// corner elliptical radii (an approximation in the corners).
fn frame_clip_sd(p : vec2f, half : vec2f, rx : vec4f, ry : vec4f) -> f32 {
  var r = vec2f(rx.x, ry.x);
  if (p.x > 0.0 && p.y < 0.0) { r = vec2f(rx.y, ry.y); }
  else if (p.x > 0.0 && p.y > 0.0) { r = vec2f(rx.z, ry.z); }
  else if (p.x <= 0.0 && p.y > 0.0) { r = vec2f(rx.w, ry.w); }
  r = min(r, half);
  let q = abs(p) - half + r;
  if (r.x > 0.0 && r.y > 0.0 && q.x > 0.0 && q.y > 0.0) {
    return (length(q / r) - 1.0) * min(r.x, r.y);
  }
  let b = abs(p) - half;
  return min(max(b.x, b.y), 0.0) + length(max(b, vec2f(0.0)));
}

// Coverage of record-space point p by clip shape idx (1 when 0).
// Anti-aliased over a device pixel, measured through the shape's
// transform (no derivatives, so callers may branch on per-instance data).
fn frame_clip_cov(p : vec2f, idx : f32) -> f32 {
  let i = u32(idx + 0.5);
  if (i == 0u || i >= arrayLength(&frame_clips)) { return 1.0; }
  let s = frame_clips[i];
  let q = vec2f(s.inv0.x * p.x + s.inv0.z * p.y + s.inv1.x,
                s.inv0.y * p.x + s.inv0.w * p.y + s.inv1.y);
  let half = s.inv1.zw * 0.5;
  let d = frame_clip_sd(q - half, half, s.rx, s.ry);
  let px = length(s.inv0) * 0.70710678 / max(frame.dpr, 1e-3);
  return clamp(0.5 - d / max(px, 1e-4), 0.0, 1.0);
}

// Document space (CSS px from doc top-left) -> WebGPU clip space.
fn doc_to_clip(p : vec2f) -> vec4f {
  let v = (p - frame.scroll) / frame.viewport;
  return vec4f(v.x * 2.0 - 1.0, 1.0 - v.y * 2.0, 0.0, 1.0);
}

// A record's position -> clip space. space < 0.5: document space (minus
// frame.scroll); otherwise viewport space (position: fixed subtrees), minus
// frame.vscroll, the target origin's viewport position (canvas anchor or
// group origin, minus the real scroll).
fn to_clip(p : vec2f, space : f32) -> vec4f {
  let o = select(frame.scroll, frame.vscroll, space > 0.5);
  let v = (p - o) / frame.viewport;
  return vec4f(v.x * 2.0 - 1.0, 1.0 - v.y * 2.0, 0.0, 1.0);
}
`

/** Bytes in the Frame uniform block (2+2+1+1+2 floats = 8 floats):
 * viewport, scroll, time, dpr, vscroll. */
export const FRAME_BYTES = 8 * 4

/** Floats per clip shape (4 vec4f; FrameClip in FRAME_WGSL). */
export const CLIP_FLOATS = 16
/** Clip shapes the table holds (slot 0 unused); beyond it a record falls
 * back to its clip rect. Fixed, so bind group 0 never changes. */
export const MAX_CLIP_SHAPES = 4096

/** A render pass owns one pipeline + its instance buffers for one layer. */
export interface RenderPass {
  readonly layer: Layer
  /** Re-pack instance buffers from the (dirty) scene. */
  upload(scene: Scene): void
  /**
   * Draw instances [first, first + count) of this layer, in scene order.
   * Called once per draw batch (Scene.batches); the renderer interleaves
   * layers so paint order holds across boxes/images/text. Returns the
   * number of `encoder.draw` calls issued (the `draws` stat) — a pass may
   * collapse several instances into one draw (e.g. atlas-backed images).
   */
  draw(
    encoder: GPURenderPassEncoder,
    first: number,
    count: number,
    material?: MaterialBinding | null
  ): number
  /** Forget a destroyed material's cached pipeline (passes that support
   * materials). */
  dropMaterial?(id: number): void
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
