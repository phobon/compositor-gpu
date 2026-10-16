// GPU ballast for perf.html (`?ballast=N`): an extra layer drawn last in
// the main pass, a full-target triangle whose fragments each run N rounds
// of arithmetic and write transparent black (no visible change). It adds a
// known amount of fragment work to every frame, so a sweep of N shows how
// much GPU time a frame really has left before frames drop
// (docs/rd/experiments/2026-10-16-gpu-headroom.md). Scissored like the
// main pass (the band with canvasFill 'band').
import type { RenderGraph } from '@/gpu/graph'
import { reportShaderErrors } from '@/util/log'

const WGSL = /* wgsl */ `
struct Ballast { rounds: u32 }
@group(1) @binding(0) var<uniform> ballast: Ballast;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var a = fract(pos.x * 0.618 + pos.y * 0.382);
  for (var k = 0u; k < ballast.rounds; k++) {
    a = fract(a * 7.31 + 0.137 * sin(a * 3.17 + f32(k)));
  }
  // Always 0 (a < 2); the compiler can't drop the loop.
  return vec4f(0.0) * step(2.0, a);
}
`

/** Add the ballast layer; returns its removal. */
export function addBallast(graph: RenderGraph, rounds: number): () => void {
  const { device, format, frameLayout } = graph.shared
  const module = device.createShaderModule({ label: 'ballast', code: WGSL })
  reportShaderErrors(module, 'ballast')
  const layout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' }
      }
    ]
  })
  const pipeline = device.createRenderPipeline({
    label: 'ballast',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [frameLayout, layout]
    }),
    vertex: { module, entryPoint: 'vs' },
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add'
            },
            alpha: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add'
            }
          }
        }
      ]
    },
    primitive: { topology: 'triangle-list' }
  })
  const uniform = device.createBuffer({
    label: 'ballast',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  })
  device.queue.writeBuffer(uniform, 0, new Uint32Array([rounds, 0, 0, 0]))
  const bindGroup = device.createBindGroup({
    layout,
    entries: [{ binding: 0, resource: { buffer: uniform } }]
  })
  return graph.addLayer({
    place: 'above',
    active: () => rounds > 0,
    draw(rp) {
      rp.setPipeline(pipeline)
      rp.setBindGroup(1, bindGroup)
      rp.draw(3)
    }
  })
}
