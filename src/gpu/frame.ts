import tgpu, { type TgpuRoot } from 'typegpu'
import * as d from 'typegpu/data'
import type { Scene } from '../scene/scene'
import type { Layer } from '../types'
import type { MaterialBinding } from './material'
import type { GpuTimer } from './timer'

/** The per-frame uniforms (bind group 0, binding 0). */
export const FrameData = d
  .struct({
    /** CSS px size of the target (canvas or group texture). */
    viewport: d.vec2f,
    /** Doc-space origin of the target, CSS px. */
    scroll: d.vec2f,
    /** ms since load. */
    time: d.f32,
    dpr: d.f32,
    /** Offset subtracted from viewport-space positions. */
    vscroll: d.vec2f
  })
  .$name('Frame')

/** An exact clip shape (Scene.clipShapes; index 0 = none): a clipping
 * ancestor's padding box in its local frame, for rounded or rotated
 * clips (bind group 0, binding 1). */
export const FrameClipData = d
  .struct({
    /** a, b, c, d: record space -> local, linear part. */
    inv0: d.vec4f,
    /** e, f (translation), w, h (padding box size). */
    inv1: d.vec4f,
    /** Inner radii tl, tr, br, bl (horizontal). */
    rx: d.vec4f,
    /** Vertical. */
    ry: d.vec4f
  })
  .$name('FrameClip')

/** Bind group 0, shared by every pass (`Shared.frameLayout` is its GPU
 * layout). */
export const frameLayout = tgpu
  .bindGroupLayout({
    frame: { uniform: FrameData, visibility: ['vertex', 'fragment'] },
    frame_clips: {
      storage: d.arrayOf(FrameClipData),
      access: 'readonly',
      visibility: ['fragment']
    }
  })
  .$idx(0)

const L = frameLayout

/** Signed distance to a rounded rect centred at 0 (half size: half), per
 * corner elliptical radii (an approximation in the corners). */
export const frameClipSd = tgpu
  .fn(
    [d.vec2f, d.vec2f, d.vec4f, d.vec4f],
    d.f32
  )(/* wgsl */ `(p : vec2f, half : vec2f, rx : vec4f, ry : vec4f) -> f32 {
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
}`)
  .$name('frame_clip_sd')

/** Coverage of record-space point p by clip shape idx (1 when 0).
 * Anti-aliased over a device pixel, measured through the shape's
 * transform (no derivatives, so callers may branch on per-instance
 * data). */
export const frameClipCov = tgpu
  .fn(
    [d.vec2f, d.f32],
    d.f32
  )(/* wgsl */ `(p : vec2f, idx : f32) -> f32 {
  let i = u32(idx + 0.5);
  if (i == 0u || i >= arrayLength(&L.$.frame_clips)) { return 1.0; }
  let s = L.$.frame_clips[i];
  let q = vec2f(s.inv0.x * p.x + s.inv0.z * p.y + s.inv1.x,
                s.inv0.y * p.x + s.inv0.w * p.y + s.inv1.y);
  let half = s.inv1.zw * 0.5;
  let d = frame_clip_sd(q - half, half, s.rx, s.ry);
  let px = length(s.inv0) * 0.70710678 / max(L.$.frame.dpr, 1e-3);
  return clamp(0.5 - d / max(px, 1e-4), 0.0, 1.0);
}`)
  .$uses({ L, frame_clip_sd: frameClipSd })
  .$name('frame_clip_cov')

/** Document space (CSS px from doc top-left) -> WebGPU clip space. */
export const docToClip = tgpu
  .fn(
    [d.vec2f],
    d.vec4f
  )(/* wgsl */ `(p : vec2f) -> vec4f {
  let v = (p - L.$.frame.scroll) / L.$.frame.viewport;
  return vec4f(v.x * 2.0 - 1.0, 1.0 - v.y * 2.0, 0.0, 1.0);
}`)
  .$uses({ L })
  .$name('doc_to_clip')

/** A record's position -> clip space. space < 0.5: document space (minus
 * frame.scroll); otherwise viewport space (position: fixed subtrees),
 * minus frame.vscroll, the target origin's viewport position (canvas
 * anchor or group origin, minus the real scroll). */
export const toClip = tgpu
  .fn(
    [d.vec2f, d.f32],
    d.vec4f
  )(/* wgsl */ `(p : vec2f, space : f32) -> vec4f {
  let o = select(L.$.frame.scroll, L.$.frame.vscroll, space > 0.5);
  let v = (p - o) / L.$.frame.viewport;
  return vec4f(v.x * 2.0 - 1.0, 1.0 - v.y * 2.0, 0.0, 1.0);
}`)
  .$uses({ L })
  .$name('to_clip')

/** Items a shader names, by name (tgpu.resolve externals). */
export type Externals = Record<string, object>

/** `layout`'s bindings as externals under their own names, so a shader
 * names them bare (`frame.dpr`). A layout's `$` exists only during
 * resolution, so each is a getter tgpu.resolve reads then, and
 * non-enumerable so listing the externals doesn't. */
export function bindingExternals(layout: {
  readonly entries: Record<string, unknown>
  readonly $: Record<string, object>
}): Externals {
  const out: Externals = {}
  for (const key of Object.keys(layout.entries)) {
    Object.defineProperty(out, key, { get: () => layout.$[key] })
  }
  return out
}

const merge = (...sets: Externals[]): Externals =>
  Object.defineProperties(
    {},
    Object.assign({}, ...sets.map((s) => Object.getOwnPropertyDescriptors(s)))
  )

/** The Frame items by the names shaders call them. */
export const FRAME_EXTERNALS: Externals = merge(bindingExternals(L), {
  frame_clip_sd: frameClipSd,
  frame_clip_cov: frameClipCov,
  doc_to_clip: docToClip,
  to_clip: toClip
})

/** A pass's WGSL with the declarations it names (the Frame items, and
 * `externals`) resolved ahead of it: only what it uses. Names are kept,
 * so the text itself is unchanged. */
export function resolveShader(
  template: string,
  externals: Externals = {}
): string {
  return tgpu.resolve({
    template,
    externals: merge(FRAME_EXTERNALS, externals)
  })
}

/** WGSL shared by every pass, resolved from the definitions above: the
 * Frame and FrameClip structs, bind group 0, `frame_clip_sd`,
 * `frame_clip_cov`, `doc_to_clip` and `to_clip`, for shaders written
 * outside the library (fx's own passes still prepend it). The library's
 * passes use resolveShader. */
export const FRAME_WGSL: string = tgpu.resolve({
  template: 'frame_prelude',
  externals: {
    frame_prelude: tgpu['~unstable']
      // The names in this comment pull each item into the resolution.
      .declare(
        '// L.$.frame L.$.frame_clips frame_clip_cov doc_to_clip to_clip'
      )
      .$uses({
        L,
        frame_clip_cov: frameClipCov,
        doc_to_clip: docToClip,
        to_clip: toClip
      })
  }
})

/** Bytes in the Frame uniform block. */
export const FRAME_BYTES = d.sizeOf(FrameData)

const at = (pick: (f: d.Infer<typeof FrameData>) => unknown): number =>
  d.memoryLayoutOf(FrameData, pick).offset / 4

/** Float offsets of Frame's fields, for packing it from JS. */
export const FRAME_AT = {
  viewport: at((f) => f.viewport),
  scroll: at((f) => f.scroll),
  time: at((f) => f.time),
  dpr: at((f) => f.dpr),
  vscroll: at((f) => f.vscroll)
} as const

/** Floats per clip shape (FrameClipData). */
export const CLIP_FLOATS = d.sizeOf(FrameClipData) / 4
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
  /** Start compiling `mat`'s pipeline before its records are drawn. */
  warmMaterial?(mat: MaterialBinding): void
  destroy(): void
}

/** Resources every pass shares: the device, target format, and frame uniforms. */
export interface Shared {
  device: GPUDevice
  /** TypeGPU's root (GPU bind group layouts from their schemas). */
  root: TgpuRoot
  format: GPUTextureFormat
  frameLayout: GPUBindGroupLayout
  frameBindGroup: GPUBindGroup
  /** Device pixel ratio of the current frame (set by Renderer.render). */
  dpr: number
  /** GPU pass timing while the profiler runs (gpu/timer.ts); a pass's
   * descriptor spreads `timed(timer, label)`. */
  timer: GpuTimer | null
  /** The skeleton view (Compositor.skeleton, gpu/skeleton.ts): passes
   * draw with their pipelines' skeleton twins. */
  skeleton: boolean
}
