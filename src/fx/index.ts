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
} from './presets/clickRipple'
export {
  type CursorGlowOptions,
  type CursorGlowSchema,
  cursorGlow
} from './presets/cursorGlow'
export {
  type DisplaceOptions,
  type DisplaceSchema,
  displace
} from './presets/displace'
export {
  type RippleOptions,
  type RippleSchema,
  ripple
} from './presets/ripple'
export {
  EFFECT_BYTES,
  EFFECT_WGSL,
  type Fragment,
  isTgpuFn,
  type TgpuFnLike
} from './shader'
export type { Target, TargetGlyphs } from './target'
