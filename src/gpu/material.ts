import { log, reportShaderErrors } from '../util/log'
import { FRAME_WGSL, type Shared } from './frame'

// Materials (docs/EFFECTS.md "Material", extension point 2): a record pass
// (boxes, images, glyphs) compiled with an author's vertex/fragment hooks
// in place of the identity ones. Every pass's shader is assembled around
// two functions:
//
//   fn mat_vertex(local : vec2f, size : vec2f, uv : vec2f, record : u32)
//     -> vec2f                       // displaced local position
//   fn mat_fragment(m : MatIn) -> vec4f   // premultiplied output
//
// The default variant (no material) uses MAT_DEFAULT_WGSL; a Material's
// variant uses its own `code` and adds bind group 2 (its uniforms).

/** Record kinds a Material can apply to. */
export type MaterialKind = 'box' | 'image' | 'glyph'

/** WGSL kind ids, as `MatIn.kind`. */
export const MAT_KIND: Record<MaterialKind, number> = {
  box: 0,
  image: 1,
  glyph: 2
}

/** Declared by every pass before its own code. */
export const MAT_IN_WGSL = /* wgsl */ `
struct MatIn {
  color  : vec4f,   // what the record paints here, premultiplied
  local  : vec2f,   // fragment in the record's local box, CSS px (undisplaced)
  size   : vec2f,   // the record's local box size, CSS px
  uv     : vec2f,   // local / size (0..1 over the box; glyphs: the ink box)
  page   : vec2f,   // fragment position in the record's space, CSS px
  coverage : f32,   // edge coverage: glyph outline, box border box, image clip
  dist   : f32,     // box/image: rounded-box SDF, CSS px (< 0 inside); glyph 0
  record : u32,     // instance index (varies per record, not stable)
  kind   : u32,     // 0 box, 1 image, 2 glyph
};
`

/** The identity hooks (no material). */
export const MAT_DEFAULT_WGSL = /* wgsl */ `
fn mat_vertex(local : vec2f, size : vec2f, uv : vec2f, record : u32) -> vec2f {
  return local;
}
fn mat_fragment(m : MatIn) -> vec4f {
  return m.color;
}
`

/**
 * Corner `vi` of a quad split into `n` × `n` cells (six vertices per
 * cell), in [0,1]². n = 1 is the plain two-triangle quad.
 */
export const MAT_GRID_WGSL = /* wgsl */ `
fn mat_corner(vi : u32, n : u32) -> vec2f {
  var quad = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let cell = vi / 6u;
  let c = vec2f(f32(cell % n), f32(cell / n));
  return (c + quad[vi % 6u]) / f32(n);
}
`

/** A Material as the record passes see it. */
export interface MaterialBinding {
  readonly id: number
  readonly label: string
  /** WGSL defining mat_vertex and mat_fragment (and whatever they use),
   * declaring bind group 2. */
  readonly code: string
  readonly kinds: ReadonlySet<MaterialKind>
  /** Cells per side of each record's quad (>= 1). */
  readonly subdivisions: number
  /** Raw programs per kind (rawProgram): replace the pass's entry points
   * for those kinds. */
  readonly raw?: Partial<Record<MaterialKind, string>>
  readonly layout: GPUBindGroupLayout
  readonly bindGroup: GPUBindGroup
  /** Until a pass's pipeline for it has compiled, its records aren't
   * drawn there (instead of drawing with the default pipeline). */
  readonly hold?: boolean
  /** Blend state of its pipelines (default PREMUL_BLEND): the built-in
   * `mix-blend-mode` materials (gpu/blend.ts). */
  readonly blend?: GPUBlendState
  /** Called when a pass's pipeline for it has finished compiling (the
   * records draw with the default pipeline until then). */
  ready?(): void
}

/**
 * A pass's material-variant module with its entry points renamed to
 * `default_vs` / `default_fs` (plain functions the raw program may call)
 * and the raw program, which defines `@vertex fn vs` and `@fragment fn
 * fs` over the pass's own `VOut`, appended. Null if the module doesn't
 * have exactly one of each entry point.
 */
export function rawProgram(wgsl: string, raw: string): string | null {
  const vs = '@vertex\nfn vs('
  const fs = '@fragment\nfn fs('
  if (wgsl.split(vs).length !== 2 || wgsl.split(fs).length !== 2) {
    return null
  }
  // IO attributes are only legal on entry points: strip them from the
  // two signatures.
  const plain = (src: string, from: string, to: string): string => {
    const at = src.indexOf(from)
    const body = src.indexOf('{', at)
    const sig = src
      .slice(at + from.length, body)
      .replace(/@(builtin|location)\([\w]+\)\s*/g, '')
    return `${src.slice(0, at)}${to}${sig}${src.slice(body)}`
  }
  const out = plain(plain(wgsl, vs, 'fn default_vs('), fs, 'fn default_fs(')
  return `${out}\n${raw}`
}

/** Material pipelines still compiling (all passes). */
let compiling = 0
export function materialPipelinesPending(): number {
  return compiling
}
/** Bumped each time a material pipeline finishes compiling (or fails):
 * its records switch pipelines without any other input changing, so a
 * cached scene drawn before is stale (Renderer.reuseKey). */
let settled = 0
export function materialPipelinesSettled(): number {
  return settled
}

/** Blend state every record pass uses (premultiplied over). */
export const PREMUL_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
}

/**
 * Per-pass cache of material pipelines, compiled asynchronously on first
 * use (`describe` gives the descriptor for the hook code and the extra
 * layout). Until a pipeline is ready, and for good if it fails to compile
 * (bad author WGSL, already reported by reportShaderErrors), get() returns
 * null and the records draw with the default pipeline: an invalid
 * pipeline must never reach setPipeline, which would invalidate the
 * frame's whole command buffer.
 */
export class MaterialPipelines {
  /** Pipelines by source key: materials whose assembled source, cell
   * count, raw program and blend state match share one compile. Bind
   * group layouts made with the same entries are interchangeable, and the
   * source fixes the entries. */
  private readonly byKey = new Map<string, SharedPipeline>()
  /** Each material's key here (once it has asked for a pipeline). */
  private readonly keyOf = new Map<number, string>()

  constructor(
    private readonly kind: MaterialKind,
    private readonly device: GPUDevice,
    private readonly describe: (
      code: string,
      subdivisions: number,
      label: string,
      layout: GPUBindGroupLayout,
      /** Applied to the assembled module source (raw programs). */
      wrap: (wgsl: string) => string
    ) => GPURenderPipelineDescriptor
  ) {}

  private state(
    mat: MaterialBinding
  ): GPURenderPipeline | 'pending' | 'failed' | undefined {
    const key = this.keyOf.get(mat.id)
    return key === undefined ? undefined : this.byKey.get(key)?.state
  }

  /** The pipeline for `mat`, or null to draw with the default one. */
  get(mat: MaterialBinding | null | undefined): GPURenderPipeline | null {
    if (!mat?.kinds.has(this.kind)) {
      return null
    }
    const p = this.state(mat)
    if (p === undefined) {
      this.compile(mat)
      return null
    }
    return p === 'pending' || p === 'failed' ? null : p
  }

  /** Start compiling `mat`'s pipeline now, before its records are drawn
   * (Material.warm). */
  warm(mat: MaterialBinding): void {
    if (mat.kinds.has(this.kind) && this.state(mat) === undefined) {
      this.compile(mat)
    }
  }

  /** True while `mat` holds its records back here: get() returned null
   * because its pipeline is still compiling. */
  held(mat: MaterialBinding | null | undefined): boolean {
    return (
      mat?.hold === true &&
      mat.kinds.has(this.kind) &&
      this.state(mat) === 'pending'
    )
  }

  private compile(mat: MaterialBinding): void {
    const id = mat.id
    const raw = mat.raw?.[this.kind]
    const subdivisions = Math.max(1, Math.floor(mat.subdivisions))
    const key = [
      mat.code,
      subdivisions,
      raw ?? '',
      mat.blend ? JSON.stringify(mat.blend) : ''
    ].join('\u0000')
    this.keyOf.set(id, key)
    const shared = this.byKey.get(key)
    if (shared) {
      shared.users.add(id)
      if (shared.state === 'pending') {
        shared.waiting.add(mat)
      }
      return
    }
    const entry: SharedPipeline = {
      state: 'pending',
      users: new Set([id]),
      waiting: new Set([mat])
    }
    this.byKey.set(key, entry)
    const label = `${mat.label}:${this.kind}`
    let bad = false
    const wrap = (wgsl: string): string => {
      if (raw === undefined) {
        return wgsl
      }
      const out = rawProgram(wgsl, raw)
      if (out === null) {
        bad = true
        return wgsl
      }
      return out
    }
    const desc = this.describe(mat.code, subdivisions, label, mat.layout, wrap)
    const target = desc.fragment?.targets?.[0]
    if (mat.blend && target) {
      target.blend = mat.blend
    }
    if (bad) {
      log.error(`${label}: raw program: the pass shader has no vs/fs`)
      entry.state = 'failed'
      entry.waiting.clear()
      return
    }
    compiling++
    this.device
      .createRenderPipelineAsync(desc)
      .then(
        (pipeline) => {
          entry.state = pipeline
          for (const m of entry.waiting) {
            m.ready?.()
          }
        },
        (e: unknown) => {
          entry.state = 'failed'
          log.error(`${desc.label}: pipeline failed:`, (e as Error).message)
        }
      )
      .finally(() => {
        entry.waiting.clear()
        compiling--
        settled++
      })
  }

  /** Forget a destroyed material: its pipeline goes once no material
   * uses it. */
  drop(id: number): void {
    const key = this.keyOf.get(id)
    if (key === undefined) {
      return
    }
    this.keyOf.delete(id)
    const entry = this.byKey.get(key)
    if (!entry) {
      return
    }
    entry.users.delete(id)
    for (const m of entry.waiting) {
      if (m.id === id) {
        entry.waiting.delete(m)
      }
    }
    if (entry.users.size === 0) {
      this.byKey.delete(key)
    }
  }
}

/** One compiled (or compiling) material pipeline and the materials on it. */
interface SharedPipeline {
  state: GPURenderPipeline | 'pending' | 'failed'
  /** Material ids using it. */
  users: Set<number>
  /** Materials to notify (`ready`) when it finishes compiling. */
  waiting: Set<MaterialBinding>
}

/** A record pass's shader: the Frame uniform, the material interface and
 * grid, the material's hooks (`MAT_DEFAULT_WGSL` for none) and its cell
 * count, then the pass's own `body` (structs, vertex shader, fragment
 * entry point), which starts on a new line. */
export function passShader(
  hooks: string,
  subdiv: number,
  body: string
): string {
  return `
${FRAME_WGSL}
${MAT_IN_WGSL}
${MAT_GRID_WGSL}
${hooks}
const MAT_SUBDIV : u32 = ${subdiv}u;${body}`
}

/** A material pipeline chosen for a draw. */
export interface PassPipeline {
  pipeline: GPURenderPipeline
  /** Vertices per instance: 6 · n² for a material's n × n grid. */
  verts: number
  /** Set while drawing with a material's variant (bind group 2). */
  material: MaterialBinding | null
}

/**
 * A record pass's pipelines (box, image, Slug): the default one and each
 * material's variant, built from one shader body. Bind group 0 is the
 * shared Frame uniform, 1 the pass's own `layout`, 2 the material's;
 * blending is premultiplied (a material's blend state for its variant).
 */
export class PassPipelines {
  readonly default: GPURenderPipeline
  private readonly variants: MaterialPipelines

  /** `body(material)`: the pass's shader after the header (passShader),
   * with the fragment entry point for a material variant or the
   * default. */
  constructor(
    shared: Pick<Shared, 'device' | 'format' | 'frameLayout'>,
    opts: {
      kind: MaterialKind
      label: string
      layout: GPUBindGroupLayout
      body: (material: boolean) => string
    }
  ) {
    const { device, format, frameLayout } = shared
    const describe = (
      code: string,
      label: string,
      extra: GPUBindGroupLayout | null
    ): GPURenderPipelineDescriptor => {
      const module = device.createShaderModule({ label, code })
      reportShaderErrors(module, label)
      const layouts = [frameLayout, opts.layout]
      if (extra) {
        layouts.push(extra)
      }
      return {
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [{ format, blend: PREMUL_BLEND }]
        },
        primitive: { topology: 'triangle-list' }
      }
    }
    this.default = device.createRenderPipeline(
      describe(
        passShader(MAT_DEFAULT_WGSL, 1, opts.body(false)),
        opts.label,
        null
      )
    )
    this.variants = new MaterialPipelines(
      opts.kind,
      device,
      (code, n, label, layout, wrap) =>
        describe(wrap(passShader(code, n, opts.body(true))), label, layout)
    )
  }

  /** The pipeline to draw `material`'s records with: its variant once
   * compiled, else the default; null when the material holds its records
   * back until compiled. */
  pipelineFor(
    material: MaterialBinding | null | undefined
  ): PassPipeline | null {
    const mp = this.variants.get(material)
    if (!mp && this.variants.held(material)) {
      return null
    }
    if (mp && material) {
      const n = Math.max(1, Math.floor(material.subdivisions))
      return { pipeline: mp, verts: 6 * n * n, material }
    }
    return { pipeline: this.default, verts: 6, material: null }
  }

  /** Set the pipeline (and the material's bind group) for `material`'s
   * records; the vertex count per instance, or null to draw nothing. */
  use(
    encoder: GPURenderPassEncoder,
    material: MaterialBinding | null | undefined
  ): number | null {
    const p = this.pipelineFor(material)
    if (!p) {
      return null
    }
    encoder.setPipeline(p.pipeline)
    if (p.material) {
      encoder.setBindGroup(2, p.material.bindGroup)
    }
    return p.verts
  }

  drop(id: number): void {
    this.variants.drop(id)
  }

  warm(mat: MaterialBinding): void {
    this.variants.warm(mat)
  }
}
