import tgpu from 'typegpu'
import * as d from 'typegpu/data'
import { log } from '../util/log'
import type { ParamSchema, ParamType } from './params'
import { isTgpuFn, type TgpuFnLike } from './shader'

// TypeGPU externals: the declarations every effect shader already has
// (fx, params, pointer, sample, data, ...) as TypeGPU values, so a
// JS-bodied (`'use gpu'`, unplugin-typegpu) tgpu.fn can use them, plus the
// hook structs for tgpu.fn hooks. Contract: src/fx/README.md "TypeGPU".

const snippet = <T extends d.AnyData>(expr: string, type: T) =>
  tgpu['~unstable'].rawCodeSnippet(expr, type, 'uniform', false)

const call = <T extends d.AnyWgslData>(
  name: string,
  args: d.AnyWgslData[],
  ret: T,
  params: string,
  body: string
) => tgpu.fn(args, ret)(`(${params}) { ${body} }`).$name(name)

/** Material fragment hook input (`MatIn` in WGSL). */
export const MatIn = d
  .struct({
    color: d.vec4f,
    local: d.vec2f,
    size: d.vec2f,
    uv: d.vec2f,
    page: d.vec2f,
    coverage: d.f32,
    dist: d.f32,
    record: d.u32,
    kind: d.u32
  })
  .$name('fx_mat_in')

/** Layer vertex output / fragment input (`Quad` in WGSL). */
export const Quad = d
  .struct({ pos: d.vec2f, uv: d.vec2f, color: d.vec4f, extra: d.vec4f })
  .$name('fx_quad')

const PARAM_TYPES = {
  f32: d.f32,
  vec2: d.vec2f,
  vec3: d.vec3f,
  vec4: d.vec4f,
  color: d.vec4f
} as const

type ParamSnippets<S extends ParamSchema> = {
  [K in keyof S]: ReturnType<
    typeof snippet<(typeof PARAM_TYPES)[S[K]['type'] & ParamType]>
  >
}

const pointer = {
  pos: snippet('pointer.pos', d.vec2f),
  page: snippet('pointer.page', d.vec2f),
  vel: snippet('pointer.vel', d.vec2f),
  follow: snippet('pointer.follow', d.vec2f),
  followVel: snippet('pointer.follow_vel', d.vec2f),
  down: snippet('pointer.down', d.f32),
  seen: snippet('pointer.seen', d.f32),
  clicksN: snippet('pointer.clicks_n', d.f32),
  /** Click k: x, y (page CSS px), t (s), _. */
  click: call('fx_click', [d.u32], d.vec4f, 'k', 'return pointer.clicks[k];')
}

/**
 * Values for JS-bodied TypeGPU functions. Each stands for a declaration
 * the effect's shader already has, so it only resolves inside that kind
 * of shader (`pass.sample` in a Pass, `layer.data` in a Layer, ...).
 */
export const gpu = {
  /** Page clock, s (every kind). */
  time: snippet('fx.time', d.f32),
  /** s since the effect was last enabled (every kind). */
  elapsed: snippet('fx.elapsed', d.f32),
  dpr: snippet('fx.dpr', d.f32),
  pointer,
  /** Typed accessors for a Params schema: `gpu.params(schema).strength.$`. */
  params<S extends ParamSchema>(schema: S): ParamSnippets<S> {
    const out: Record<string, unknown> = {}
    for (const [k, def] of Object.entries(schema)) {
      out[k] = snippet(`params.${k}`, PARAM_TYPES[def.type])
    }
    return out as ParamSnippets<S>
  },
  pass: {
    sample: call('fx_sample', [d.vec2f], d.vec4f, 'uv', 'return sample(uv);'),
    viewportToUv: call(
      'fx_viewport_to_uv',
      [d.vec2f],
      d.vec2f,
      'p',
      'return viewport_to_uv(p);'
    ),
    pageToUv: call(
      'fx_page_to_uv',
      [d.vec2f],
      d.vec2f,
      'p',
      'return page_to_uv(p);'
    ),
    /** With `image`. */
    image: call('fx_pass_image', [d.vec2f], d.vec4f, 'uv', 'return image(uv);'),
    imageLevel: call(
      'fx_pass_image_level',
      [d.vec2f, d.f32],
      d.vec4f,
      'uv, lod',
      'return image_level(uv, lod);'
    ),
    imageSize: call(
      'fx_pass_image_size',
      [],
      d.vec2f,
      '',
      'return image_size();'
    )
  },
  layer: {
    count: snippet('fx.count', d.f32),
    dt: snippet('fx.dt', d.f32),
    steps: snippet('fx.steps', d.f32),
    scroll: snippet('fx.scroll', d.vec2f),
    viewport: snippet('fx.viewport', d.vec2f),
    data: call('fx_data1', [d.u32, d.u32], d.f32, 'i, k', 'return data(i, k);'),
    data2: call(
      'fx_data2',
      [d.u32, d.u32],
      d.vec2f,
      'i, k',
      'return data2(i, k);'
    ),
    data4: call(
      'fx_data4',
      [d.u32, d.u32],
      d.vec4f,
      'i, k',
      'return data4(i, k);'
    ),
    /** simulate only. */
    setData: tgpu
      .fn([d.u32, d.u32, d.f32])('(i, k, v) { set_data(i, k, v); }')
      .$name('fx_set_data1'),
    setData2: tgpu
      .fn([d.u32, d.u32, d.vec2f])('(i, k, v) { set_data2(i, k, v); }')
      .$name('fx_set_data2'),
    setData4: tgpu
      .fn([d.u32, d.u32, d.vec4f])('(i, k, v) { set_data4(i, k, v); }')
      .$name('fx_set_data4'),
    /** With `image`. */
    image: call('fx_image', [d.vec2f], d.vec4f, 'uv', 'return image(uv);'),
    /** With `glyphs`. */
    glyphCount: call('fx_glyph_count', [], d.u32, '', 'return glyph_count();'),
    glyphPoint: call(
      'fx_glyph_point',
      [d.u32, d.vec2f],
      d.vec2f,
      'k, uv',
      'return glyph_point(k, uv);'
    ),
    glyphSize: call(
      'fx_glyph_size',
      [d.u32],
      d.vec2f,
      'k',
      'return glyph_size(k);'
    ),
    glyphColor: call(
      'fx_glyph_color',
      [d.u32],
      d.vec4f,
      'k',
      'return glyph_color(k);'
    ),
    glyphClip: call(
      'fx_glyph_clip',
      [d.u32],
      d.vec4f,
      'k',
      'return glyph_clip(k);'
    ),
    glyphCoverage: call(
      'fx_glyph_coverage',
      [d.u32, d.vec2f],
      d.f32,
      'k, uv',
      'return glyph_coverage(k, uv);'
    )
  },
  material: {
    /** Images: the source `delta` CSS px away (zero for other kinds). */
    sample: call(
      'fx_mat_sample',
      [d.vec2f],
      d.vec4f,
      'delta',
      'return mat_sample(delta);'
    ),
    /** Glyphs: the index in the target's glyphs (stable); boxes and
     * images: the instance index. */
    index: call(
      'fx_mat_index',
      [d.u32],
      d.u32,
      'record',
      'return mat_index(record);'
    ),
    /** Glyphs in the target (glyph materials; 0 otherwise). */
    glyphs: snippet('fx.glyphs', d.f32)
  }
}

/** A hook: WGSL text or a tgpu.fn. */
export type Hook = string | TgpuFnLike

/** How a tgpu.fn hook is wrapped into the WGSL function the shader
 * calls. `call` is the wrapper's body, with `fx_user` the author's fn. */
export interface HookSpec {
  /** Name in error messages. */
  role: string
  /** Expected arg types (`.type` strings, or a struct by identity). */
  args: readonly (string | object)[]
  /** Return type string, or a struct; undefined for none. */
  ret?: string | object
  /** The WGSL wrapper, calling `fx_user`. */
  wrapper: string
}

const typeName = (t: { readonly type: string }): string => t.type

const matches = (want: string | object, got: unknown): boolean =>
  typeof want === 'string'
    ? typeName(got as { type: string }).startsWith(want)
    : want === got

/**
 * The WGSL for a set of hooks: strings as written, tgpu.fn hooks
 * resolved together (one resolve, so shared externals are declared once)
 * behind their wrappers. Null (logged under `name`) on a bad hook.
 */
export function hookSource(
  name: string,
  hooks: readonly (readonly [Hook | undefined, HookSpec])[]
): string | null {
  const text: string[] = []
  const template: string[] = []
  const externals: Record<string, object> = { FxMatIn: MatIn, FxQuad: Quad }
  let i = 0
  for (const [hook, spec] of hooks) {
    if (hook === undefined) {
      continue
    }
    if (typeof hook === 'string') {
      text.push(hook)
      continue
    }
    if (!isTgpuFn(hook)) {
      log.error(`fx:${name}: ${spec.role} is neither WGSL nor a tgpu.fn`)
      return null
    }
    const shell = hook.shell as {
      argTypes: readonly unknown[]
      returnType?: unknown
    }
    const ok =
      shell.argTypes.length === spec.args.length &&
      spec.args.every((a, k) => matches(a, shell.argTypes[k])) &&
      (spec.ret === undefined
        ? !shell.returnType ||
          typeName(shell.returnType as { type: string }) === 'void'
        : matches(spec.ret, shell.returnType))
    if (!ok) {
      log.error(
        `fx:${name}: ${spec.role} tgpu.fn has the wrong signature (see src/fx/README.md)`
      )
      return null
    }
    const key = `fx_user${i++}`
    externals[key] = hook
    template.push(spec.wrapper.replaceAll('fx_user', key))
  }
  if (template.length > 0) {
    try {
      text.push(
        tgpu.resolve({
          template: template.join('\n'),
          externals,
          names: 'random'
        })
      )
    } catch (e) {
      log.error(`fx:${name}: tgpu.resolve failed:`, (e as Error).message)
      return null
    }
  }
  return text.join('\n')
}

/** Material hooks. */
export const MATERIAL_HOOKS = {
  vertex: {
    role: 'vertex',
    args: ['vec2f', 'vec2f', 'vec2f', 'u32'],
    ret: 'vec2f',
    wrapper:
      'fn vertex(local : vec2f, size : vec2f, uv : vec2f, record : u32) ' +
      '-> vec2f { return fx_user(local, size, uv, record); }'
  },
  fragment: {
    role: 'fragment',
    args: [MatIn],
    ret: 'vec4f',
    wrapper:
      'fn fragment(m : MatIn) -> vec4f { return fx_user(FxMatIn(m.color, ' +
      'm.local, m.size, m.uv, m.page, m.coverage, m.dist, m.record, ' +
      'm.kind)); }'
  }
} satisfies Record<string, HookSpec>

/** Layer hooks. */
export const LAYER_HOOKS = {
  vertex: {
    role: 'vertex',
    args: ['u32', 'vec2f'],
    ret: Quad,
    wrapper:
      'fn vertex(i : u32, corner : vec2f) -> Quad { let q = fx_user(i, ' +
      'corner); return Quad(q.pos, q.uv, q.color, q.extra); }'
  },
  fragment: {
    role: 'fragment',
    args: [Quad, 'u32'],
    ret: 'vec4f',
    wrapper:
      'fn fragment(q : Quad, i : u32) -> vec4f { return fx_user(FxQuad(' +
      'q.pos, q.uv, q.color, q.extra), i); }'
  },
  simulate: {
    role: 'simulate',
    args: ['u32'],
    wrapper: 'fn simulate(i : u32) { fx_user(i); }'
  }
} satisfies Record<string, HookSpec>
