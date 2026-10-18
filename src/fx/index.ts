// `compositor-gpu/fx`: the effects layer (docs/EFFECTS.md, src/fx/README.md).
// Importing it does nothing; createEffects() is the only entry to DOM/GPU
// work.
import '../util/env'

export type { MaterialKind } from '../gpu/material'
export {
  createEffects,
  type Effects,
  type FxOverride,
  type Pass,
  type PassOptions
} from './effects'
export { gpu, type Hook, MatIn, Quad } from './gpu'
export {
  LAYER_FX_BYTES,
  type Layer,
  type LayerOptions
} from './layer'
export {
  MATERIAL_FX_BYTES,
  type Material,
  type MaterialOptions
} from './material'
export {
  type Bezier,
  cubicBezier,
  type Motion,
  type MotionOptions,
  type MotionSchema,
  type MotionValues,
  type PlayOptions
} from './motion'
export {
  createParams,
  type ParamBlock,
  type ParamDef,
  type ParamSchema,
  type ParamType,
  type ParamValues,
  parseHex
} from './params'
export {
  CLICKS,
  POINTER_BYTES,
  POINTER_WGSL,
  type PointerOverride
} from './pointer'
export { type BlurOptions, type BlurSchema, blur } from './presets/blur'
export {
  type ClickRippleOptions,
  type ClickRippleSchema,
  clickRipple
} from './presets/click_ripple'
export {
  type CursorGlowOptions,
  type CursorGlowSchema,
  cursorGlow
} from './presets/cursor_glow'
export {
  type DevelopOptions,
  type DevelopSchema,
  develop
} from './presets/develop'
export {
  type DisplaceOptions,
  type DisplaceSchema,
  displace
} from './presets/displace'
export {
  type DissolveOptions,
  type DissolveSchema,
  dissolve
} from './presets/dissolve'
export {
  type EdgeLensOptions,
  type EdgeLensSchema,
  edgeLens
} from './presets/edge_lens'
export {
  type GalleryOptions,
  type GallerySchema,
  gallery
} from './presets/gallery'
export {
  type GlitchSlicesOptions,
  type GlitchSlicesSchema,
  glitchSlices
} from './presets/glitch_slices'
export { type LensOptions, type LensSchema, lens } from './presets/lens'
export {
  type ProgressiveBlurOptions,
  type ProgressiveBlurSchema,
  progressiveBlur
} from './presets/progressive_blur'
export {
  type RadialRevealOptions,
  type RadialRevealSchema,
  radialReveal
} from './presets/radial_reveal'
export {
  type RevealOptions,
  type RevealSchema,
  reveal
} from './presets/reveal'
export {
  type RgbSplitOptions,
  type RgbSplitSchema,
  rgbSplit
} from './presets/rgb_split'
export {
  type RippleOptions,
  type RippleSchema,
  ripple
} from './presets/ripple'
export {
  type SpotlightOptions,
  type SpotlightSchema,
  spotlight
} from './presets/spotlight'
export {
  type TextStaggerOptions,
  type TextStaggerSchema,
  textStagger
} from './presets/text_stagger'
export {
  type TouchTrail,
  type TouchTrailParams,
  type TouchTrailSchema,
  touchTrail
} from './presets/touch_trail'
export {
  type VignetteOptions,
  type VignetteSchema,
  vignette
} from './presets/vignette'
export {
  EFFECT_BYTES,
  EFFECT_WGSL,
  type Fragment,
  isTgpuFn,
  type TgpuFnLike
} from './shader'
export type { Target, TargetGlyphs, TargetImage } from './target'
export {
  TRAIL_INFO_BYTES,
  type Trail,
  type TrailOptions,
  type TrailSchema,
  trailWgsl
} from './trail'
export type {
  Transform,
  TransformOptions,
  TransformValues
} from './transform'
export type { Transition, TransitionOptions } from './transition'
