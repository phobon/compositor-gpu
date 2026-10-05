import { log } from '../util/log'

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
  readonly layout: GPUBindGroupLayout
  readonly bindGroup: GPUBindGroup
  /** Called when a pass's pipeline for it has finished compiling (the
   * records draw with the default pipeline until then). */
  ready?(): void
}

/** Material pipelines still compiling (all passes). */
let compiling = 0
export function materialPipelinesPending(): number {
  return compiling
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
  private readonly cache = new Map<
    number,
    GPURenderPipeline | 'pending' | 'failed'
  >()

  constructor(
    private readonly kind: MaterialKind,
    private readonly device: GPUDevice,
    private readonly describe: (
      code: string,
      subdivisions: number,
      label: string,
      layout: GPUBindGroupLayout
    ) => GPURenderPipelineDescriptor
  ) {}

  /** The pipeline for `mat`, or null to draw with the default one. */
  get(mat: MaterialBinding | null | undefined): GPURenderPipeline | null {
    if (!mat?.kinds.has(this.kind)) {
      return null
    }
    const p = this.cache.get(mat.id)
    if (p === undefined) {
      this.compile(mat)
      return null
    }
    return p === 'pending' || p === 'failed' ? null : p
  }

  private compile(mat: MaterialBinding): void {
    const id = mat.id
    this.cache.set(id, 'pending')
    compiling++
    const desc = this.describe(
      mat.code,
      Math.max(1, Math.floor(mat.subdivisions)),
      `${mat.label}:${this.kind}`,
      mat.layout
    )
    this.device
      .createRenderPipelineAsync(desc)
      .then(
        (pipeline) => {
          if (this.cache.get(id) === 'pending') {
            this.cache.set(id, pipeline)
            mat.ready?.()
          }
        },
        (e: unknown) => {
          if (this.cache.get(id) === 'pending') {
            this.cache.set(id, 'failed')
          }
          log.error(`${desc.label}: pipeline failed:`, (e as Error).message)
        }
      )
      .finally(() => {
        compiling--
      })
  }

  /** Forget a destroyed material's pipeline. */
  drop(id: number): void {
    this.cache.delete(id)
  }
}
