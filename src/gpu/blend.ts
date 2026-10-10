import { BLEND_BASE, BLEND_MODES, type BlendMode } from '../scene/blend'
import type { MaterialEntry } from './graph'
import { MAT_DEFAULT_WGSL } from './material'

// Built-in materials for `mix-blend-mode` (scene/blend.ts): identity hooks,
// an empty bind group 2, and the mode's blend state. Alpha always
// composites normally (premultiplied over).

const OVER: GPUBlendComponent = {
  srcFactor: 'one',
  dstFactor: 'one-minus-src-alpha',
  operation: 'add'
}

const COLOR: Record<BlendMode, GPUBlendComponent> = {
  multiply: { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha' },
  screen: { srcFactor: 'one', dstFactor: 'one-minus-src' },
  'plus-lighter': { srcFactor: 'one', dstFactor: 'one' },
  // src·(1 − dst) + dst·(1 − src) = src + dst − 2·src·dst, exact with
  // premultiplied src (coverage folds in).
  exclusion: { srcFactor: 'one-minus-dst', dstFactor: 'one-minus-src' },
  difference: { srcFactor: 'one-minus-dst', dstFactor: 'one-minus-src' }
}

/** One MaterialEntry per supported mode, registered by the compositor.
 * `ready` runs when a pass's pipeline for one has compiled (request a
 * frame: its records were held until then). */
export function blendMaterials(
  device: GPUDevice,
  ready: () => void
): MaterialEntry[] {
  const layout = device.createBindGroupLayout({
    label: 'blend',
    entries: []
  })
  const bindGroup = device.createBindGroup({
    label: 'blend',
    layout,
    entries: []
  })
  return BLEND_MODES.map((mode, i) => ({
    id: BLEND_BASE + i,
    label: `blend:${mode}`,
    code: MAT_DEFAULT_WGSL,
    kinds: new Set(['box', 'image', 'glyph'] as const),
    subdivisions: 1,
    layout,
    bindGroup,
    blend: { color: { operation: 'add', ...COLOR[mode] }, alpha: OVER },
    // Don't flash the normal blend while the variant compiles.
    hold: true,
    builtin: true,
    target: document.documentElement,
    active: () => true,
    ready
  }))
}
