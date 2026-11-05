import { BUILTINS } from './builtin_effects'
import type { Effects } from './effects'
import type { ParamSchema } from './params'

// The effects a config (config.ts) and the editor (docs/EDITOR.md) can
// name, behind one signature. The presets are listed in
// builtin_effects.ts; sites add their own with registerEffect().

export type EffectScope = 'page' | 'element'

/** What a config holds of a created effect. */
export interface EffectHandle {
  /** Live params by schema key: f32 as numbers, the rest as arrays. */
  readonly params: Record<string, unknown>
  enabled: boolean
  /** A one-shot effect's start (EffectDef.impulse), from an element, a
   * page point (CSS px) or nowhere in particular. */
  play?(at: Element | readonly [number, number] | null): void
  destroy(): void
}

export interface EffectDef {
  /** The name a config uses (`"effect": "spotlight"`). */
  readonly id: string
  readonly label: string
  /** 'page': created with no element; 'element': on each matched one. */
  readonly scopes: readonly EffectScope[]
  /** Its params. A `progress` param is what `play` triggers tween. */
  readonly schema: ParamSchema
  /** `play` calls the handle's play() instead of tweening progress. */
  readonly impulse?: boolean
  /** `el` is null for the page scope. */
  create(fx: Effects, el: Element | null): EffectHandle
}

let defs: Map<string, EffectDef> | null = null

const all = (): Map<string, EffectDef> => {
  defs ??= new Map(BUILTINS.map((d) => [d.id, d]))
  return defs
}

/** Add `def`, replacing one with the same id. Returns its removal. */
export function registerEffect(def: EffectDef): () => void {
  all().set(def.id, def)
  return () => {
    if (all().get(def.id) === def) {
      all().delete(def.id)
    }
  }
}

export function getEffect(id: string): EffectDef | undefined {
  return all().get(id)
}

/** Every registered effect, in registration order. */
export function listEffects(): EffectDef[] {
  return [...all().values()]
}
