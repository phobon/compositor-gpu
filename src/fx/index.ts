// `compositor-gpu/fx`: the effects layer (docs/EFFECTS.md, src/fx/README.md).
// Importing it does nothing; createEffects() is the only entry to DOM/GPU
// work.
import '../util/env'

export {
  createEffects,
  type Effects,
  type FxOverride,
  type Pass,
  type PassOptions
} from './effects'
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
  type DisplaceOptions,
  type DisplaceSchema,
  displace
} from './presets/displace'
export {
  EFFECT_BYTES,
  EFFECT_WGSL,
  type Fragment,
  isTgpuFn,
  type TgpuFnLike
} from './shader'
