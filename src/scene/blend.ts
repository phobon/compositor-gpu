// `mix-blend-mode`, mirrored per record. The reader tags each record of a
// blended element's subtree (and of a blended pseudo-element) with a
// built-in material id; the renderer registers one built-in material per
// mode (gpu/blend.ts) whose pipeline variant has that mode's blend state
// and identity hooks. Supported, all in premultiplied sRGB like the rest of
// the mirror, against what has already painted into the same target:
//
//   multiply      exact: src·dst + dst·(1 − αs)
//   screen        exact: src + dst − src·dst
//   plus-lighter  exact: src + dst (clamped)
//   exclusion     exact: src + dst − 2·src·dst
//   difference    approximated by exclusion: identical where the source is
//                 black or white (the usual invert idiom), close elsewhere
//
// CSS blends the element's whole subtree as one isolated group; here each
// record blends on its own, which differs only where the subtree's own
// records overlap. An `/fx` Material on the same records wins (they draw
// with its pipeline and the normal blend). Other modes draw normally.

/** First built-in blend material id (fx materials count up from 1). */
export const BLEND_BASE = 1 << 24

export const BLEND_MODES = [
  'multiply',
  'screen',
  'plus-lighter',
  'exclusion',
  'difference'
] as const

export type BlendMode = (typeof BLEND_MODES)[number]

/** The built-in material id for a computed `mix-blend-mode`, or undefined
 * for `normal` and unsupported modes. */
export function blendMaterialId(mode: string): number | undefined {
  const i = (BLEND_MODES as readonly string[]).indexOf(mode)
  return i === -1 ? undefined : BLEND_BASE + i
}
