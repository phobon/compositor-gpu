// The skeleton view (Compositor.skeleton, Shared.skeleton): every record
// pass, fallback glyph, cutout and /fx Layer draws its geometry as
// wireframe instead of shading it. Each pipeline gets a twin
// (skeletonPipeline) over the same module: `line-list`, the SKELETON
// override on, and the fragment entry `skeleton_fs` (a flat colour per
// part). With SKELETON on, a vertex shader's triangle-list vertex index
// goes through skeleton_vi, which walks each triangle's three edges, so
// an instance takes 12 vertices per grid cell instead of 6. Everything
// downstream is unchanged: material vertex hooks bend the wires, groups
// composite them through layer transforms, post passes distort them.

/** Outline colour per part (sRGB hex). */
export const SKELETON_COLORS = {
  box: '#22d3ee',
  image: '#f59e0b',
  glyph: '#34d399',
  fallback: '#f472b6',
  cutout: '#ef4444',
  layer: '#a78bfa'
} as const

export type SkeletonPart = keyof typeof SKELETON_COLORS

/** Declared by every shader with a skeleton twin, before its vertex
 * shader. */
export const SKELETON_WGSL = /* wgsl */ `
override SKELETON : bool = false;
// Triangle-list vertex index for vertex vi: as is, or with SKELETON on
// (line-list, six vertices per triangle) the ends of edge (vi % 6) / 2
// of triangle vi / 6.
fn skeleton_vi(vi : u32) -> u32 {
  if (!SKELETON) { return vi; }
  var ends = array<u32, 6>(0u, 1u, 1u, 2u, 2u, 0u);
  return (vi / 6u) * 3u + ends[vi % 6u];
}
`

/** The fragment entry point of `part`'s skeleton twin; append it to the
 * module source. */
export function skeletonFs(part: SkeletonPart): string {
  const n = Number.parseInt(SKELETON_COLORS[part].slice(1), 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) => (v / 255).toFixed(4))
    .join(', ')
  return `
@fragment
fn skeleton_fs() -> @location(0) vec4f {
  return vec4f(${c}, 1.0);
}
`
}

/** Vertices per instance for an n × n grid. */
export function quadVerts(skeleton: boolean, n = 1): number {
  return (skeleton ? 12 : 6) * n * n
}

const OVER: GPUBlendComponent = {
  srcFactor: 'one',
  dstFactor: 'one-minus-src-alpha'
}

/** `desc`'s skeleton twin (its module has SKELETON_WGSL and skeleton_fs). */
export function skeletonDescriptor(
  desc: GPURenderPipelineDescriptor
): GPURenderPipelineDescriptor {
  const target = desc.fragment?.targets?.[0]
  const format = target?.format ?? 'bgra8unorm'
  return {
    ...desc,
    label: `${desc.label ?? 'pipeline'}:skeleton`,
    vertex: {
      ...desc.vertex,
      constants: { ...desc.vertex.constants, SKELETON: 1 }
    },
    fragment: {
      module: desc.fragment?.module ?? desc.vertex.module,
      entryPoint: 'skeleton_fs',
      targets: [{ format, blend: { color: OVER, alpha: OVER } }]
    },
    primitive: { topology: 'line-list' }
  }
}

/** A pipeline and its skeleton twin, built on first use. */
export class SkeletonTwin {
  private twin: GPURenderPipeline | null = null

  constructor(
    private readonly device: GPUDevice,
    private readonly desc: GPURenderPipelineDescriptor,
    readonly pipeline: GPURenderPipeline = device.createRenderPipeline(desc)
  ) {}

  get(skeleton: boolean): GPURenderPipeline {
    if (!skeleton) {
      return this.pipeline
    }
    this.twin ??= this.device.createRenderPipeline(
      skeletonDescriptor(this.desc)
    )
    return this.twin
  }
}
