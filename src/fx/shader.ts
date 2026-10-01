import tgpu from 'typegpu'
import { FRAME_WGSL } from '../gpu/frame'
import { log } from '../util/log'
import { POINTER_WGSL } from './pointer'

// Shader assembly for fullscreen passes. The author supplies
//   fn effect(uv: vec2f, src: texture_2d<f32>, smp: sampler) -> vec4f
// (as WGSL, or a tgpu.fn with that signature); this file wraps it with the
// Frame/Effect/Params/Pointer declarations, the bindings and the entry
// points. The contract is documented in src/fx/README.md.

/** Bytes in the Effect uniform (see EFFECT_WGSL). */
export const EFFECT_BYTES = 80

export const EFFECT_WGSL = /* wgsl */ `
struct Effect {
  time       : f32,    // page clock, s
  elapsed    : f32,    // s since this effect was last enabled
  viewport   : vec2f,  // visible viewport, device px
  texel      : vec2f,  // one device px in uv (1 / viewport)
  scroll     : vec2f,  // the viewport's document-space origin, CSS px
  dpr        : f32,
  _pad       : f32,
  origin     : vec2f,  // runtime: viewport top-left in canvas device px
  src_origin : vec2f,  // runtime: src texel (0,0) in canvas device px
  src_size   : vec2f,  // runtime: src's valid region, device px
  dst_origin : vec2f,  // runtime: target texel (0,0) in canvas device px
  src_texel  : vec2f,  // runtime: 1 / src texture size
};
`

const BINDINGS_WGSL = /* wgsl */ `
@group(1) @binding(0) var fx_src : texture_2d<f32>;
@group(1) @binding(1) var fx_smp : sampler;
@group(2) @binding(0) var<uniform> fx : Effect;
@group(2) @binding(1) var<uniform> params : Params;
@group(2) @binding(2) var<uniform> pointer : Pointer;

// uv over the visible viewport -> texture coordinates of the source,
// clamped half a texel inside its valid region (edge texels repeat; a
// pooled texture can be larger than what was drawn into it).
fn src_uv(uv : vec2f) -> vec2f {
  let p = fx.origin + uv * fx.viewport - fx.src_origin;
  return clamp(p, vec2f(0.5), fx.src_size - 0.5) * fx.src_texel;
}

// The source (the scene, or the previous stage), premultiplied, at uv.
// Level 0 with no derivatives, so it is legal in non-uniform control flow.
fn sample(uv : vec2f) -> vec4f {
  return textureSampleLevel(fx_src, fx_smp, src_uv(uv), 0.0);
}

// Viewport CSS px -> uv (the pointer's pos/follow).
fn viewport_to_uv(p : vec2f) -> vec2f {
  return p * fx.dpr / fx.viewport;
}

// Page (document) CSS px -> uv (pointer.page, clicks).
fn page_to_uv(p : vec2f) -> vec2f {
  return (p - fx.scroll) * fx.dpr / fx.viewport;
}
`

const ENTRY_WGSL = /* wgsl */ `
@vertex
fn fx_vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fx_fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let uv = (pos.xy + fx.dst_origin - fx.origin) / fx.viewport;
  return effect(uv, fx_src, fx_smp);
}
`

const PASSTHROUGH = /* wgsl */ `
fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) -> vec4f {
  return sample(uv);
}
`

/** The shape of a TypeGPU function this module accepts (`tgpu.fn`). */
export interface TgpuFnLike {
  readonly resourceType: 'function'
  readonly shell: {
    readonly argTypes: readonly { readonly type: string }[]
    readonly returnType: { readonly type: string }
  }
}

/** A Pass fragment: WGSL defining `effect`, or a `tgpu.fn`. */
export type Fragment = string | TgpuFnLike

export function isTgpuFn(f: unknown): f is TgpuFnLike {
  if ((typeof f !== 'function' && typeof f !== 'object') || f === null) {
    return false
  }
  const o = f as Partial<TgpuFnLike>
  return o.resourceType === 'function' && Array.isArray(o.shell?.argTypes)
}

const SIGNATURE = ['vec2f', 'texture_2d', 'sampler']

/**
 * WGSL defining `fn effect` for `fragment`. A tgpu.fn is resolved by
 * TypeGPU behind a wrapper `effect` that calls it; it must take
 * (vec2f, texture_2d<f32>, sampler) and return vec4f. Null (and an
 * error logged under `name`) when it doesn't fit or fails to resolve.
 */
export function effectSource(fragment: Fragment, name: string): string | null {
  if (typeof fragment === 'string') {
    return fragment
  }
  if (!isTgpuFn(fragment)) {
    log.error(`fx:${name}: fragment is neither WGSL nor a tgpu.fn`)
    return null
  }
  const args = fragment.shell.argTypes.map((t) => t.type)
  const ok =
    args.length === 3 &&
    args.every((t, i) => t === SIGNATURE[i]) &&
    fragment.shell.returnType.type === 'vec4f'
  if (!ok) {
    log.error(
      `fx:${name}: tgpu.fn must be (vec2f, texture2d, sampler) -> vec4f, ` +
        `got (${args.join(', ')}) -> ${fragment.shell.returnType.type}`
    )
    return null
  }
  try {
    return tgpu.resolve({
      template:
        'fn effect(uv : vec2f, src : texture_2d<f32>, smp : sampler) ' +
        '-> vec4f { return fx_user(uv, src, smp); }',
      externals: { fx_user: fragment }
    })
  } catch (e) {
    log.error(`fx:${name}: tgpu.resolve failed:`, (e as Error).message)
    return null
  }
}

/** The complete module source for one stage. */
export function stageSource(effect: string | null, paramsWgsl: string): string {
  return [
    FRAME_WGSL,
    EFFECT_WGSL,
    paramsWgsl,
    POINTER_WGSL,
    BINDINGS_WGSL,
    effect ?? PASSTHROUGH,
    ENTRY_WGSL
  ].join('\n')
}
