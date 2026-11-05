import type { Effects } from './effects'
import type { MotionValues } from './motion'
import type { ParamSchema } from './params'
import { blur, schema as blurSchema } from './presets/blur'
import {
  clickRipple,
  schema as clickRippleSchema
} from './presets/click_ripple'
import { cursorGlow, schema as cursorGlowSchema } from './presets/cursor_glow'
import { develop, schema as developSchema } from './presets/develop'
import { displace, schema as displaceSchema } from './presets/displace'
import { dissolve, schema as dissolveSchema } from './presets/dissolve'
import { edgeLens, schema as edgeLensSchema } from './presets/edge_lens'
import {
  glitchSlices,
  schema as glitchSlicesSchema
} from './presets/glitch_slices'
import { glow, schema as glowSchema } from './presets/glow'
import { lens, schema as lensSchema } from './presets/lens'
import {
  progressiveBlur,
  schema as progressiveBlurSchema
} from './presets/progressive_blur'
import { reveal, schema as revealSchema } from './presets/reveal'
import { rgbSplit, schema as rgbSplitSchema } from './presets/rgb_split'
import { ripple, schema as rippleSchema } from './presets/ripple'
import { shockwave, schema as shockwaveSchema } from './presets/shockwave'
import { spotlight, schema as spotlightSchema } from './presets/spotlight'
import {
  textStagger,
  schema as textStaggerSchema
} from './presets/text_stagger'
import { vignette, schema as vignetteSchema } from './presets/vignette'
import type { EffectDef, EffectHandle, EffectScope } from './registry'

// The presets as registry entries (registry.ts): each created with no
// options but its element, then given the config's params. Left out:
// gallery, morph, layoutMorph, radialReveal and touchTrail, which take
// inputs beyond params (images, poses, states, a trail).

const PAGE: readonly EffectScope[] = ['page']
const ELEMENT: readonly EffectScope[] = ['element']
const BOTH: readonly EffectScope[] = ['page', 'element']

const need = (el: Element | null, id: string): Element => {
  if (!el) {
    throw new Error(`fx config: ${id} needs an element`)
  }
  return el
}

/** Region-capable passes: fullscreen on the page, a region on an
 * element. */
const region = (
  id: string,
  label: string,
  schema: ParamSchema,
  make: (fx: Effects, opts: { region?: Element }) => EffectHandle
): EffectDef => ({
  id,
  label,
  scopes: BOTH,
  schema,
  create: (fx, el) => make(fx, el ? { region: el } : {})
})

const CHANNELS = ['x', 'y', 'scale', 'rotate', 'opacity'] as const
const REST: Pick<MotionValues, (typeof CHANNELS)[number]> = {
  x: 0,
  y: 0,
  scale: 1,
  rotate: 0,
  opacity: 1
}
const RANGE: Record<(typeof CHANNELS)[number], [number, number]> = {
  x: [-400, 400],
  y: [-400, 400],
  scale: [0, 2],
  rotate: [-180, 180],
  opacity: [0, 1]
}

const motionSchema: ParamSchema = {
  progress: { type: 'f32', default: 0, min: 0, max: 1 }
}
for (const side of ['from', 'to'] as const) {
  for (const ch of CHANNELS) {
    const [min, max] = RANGE[ch]
    motionSchema[`${side}.${ch}`] = {
      type: 'f32',
      default: REST[ch],
      min,
      max
    }
  }
}

/** fx.motion with flat params (`from.y`, `to.scale`, `progress`); its
 * own ease stays linear, the trigger's timing eases progress. */
const motionDef: EffectDef = {
  id: 'motion',
  label: 'Motion',
  scopes: ELEMENT,
  schema: motionSchema,
  create(fx, el) {
    const m = fx.motion(need(el, 'motion'), { from: REST, to: REST })
    const params: Record<string, unknown> = {}
    for (const side of ['from', 'to'] as const) {
      for (const ch of CHANNELS) {
        Object.defineProperty(params, `${side}.${ch}`, {
          enumerable: true,
          get: () => m.params[side][ch],
          set: (v: number) => {
            m.params[side][ch] = v
          }
        })
      }
    }
    Object.defineProperty(params, 'progress', {
      enumerable: true,
      get: () => m.progress,
      set: (v: number) => {
        m.progress = v
      }
    })
    return {
      params,
      get enabled() {
        return m.enabled
      },
      set enabled(v: boolean) {
        m.enabled = v
      },
      destroy: () => m.destroy()
    }
  }
}

export const BUILTINS: readonly EffectDef[] = [
  region('blur', 'Blur', blurSchema, blur),
  region(
    'progressiveBlur',
    'Progressive blur',
    progressiveBlurSchema,
    progressiveBlur
  ),
  region('displace', 'Displace', displaceSchema, displace),
  region('rgbSplit', 'RGB split', rgbSplitSchema, rgbSplit),
  region('glitchSlices', 'Glitch slices', glitchSlicesSchema, glitchSlices),
  region('lens', 'Lens', lensSchema, lens),
  {
    id: 'vignette',
    label: 'Vignette',
    scopes: PAGE,
    schema: vignetteSchema,
    create: (fx) => vignette(fx)
  },
  {
    id: 'edgeLens',
    label: 'Edge lens',
    scopes: PAGE,
    schema: edgeLensSchema,
    create: (fx) => edgeLens(fx)
  },
  {
    id: 'cursorGlow',
    label: 'Cursor glow',
    scopes: PAGE,
    schema: cursorGlowSchema,
    create: (fx) => cursorGlow(fx)
  },
  {
    id: 'clickRipple',
    label: 'Click ripple',
    scopes: PAGE,
    schema: clickRippleSchema,
    create: (fx) => clickRipple(fx)
  },
  {
    id: 'shockwave',
    label: 'Shockwave',
    scopes: PAGE,
    schema: shockwaveSchema,
    impulse: true,
    create(fx) {
      const s = shockwave(fx)
      return {
        params: s.pass.params,
        get enabled() {
          return s.pass.enabled
        },
        set enabled(v: boolean) {
          s.pass.enabled = v
        },
        play: (at) =>
          s.play(
            at === null ? undefined : 'nodeType' in at ? at : [at[0], at[1]]
          ),
        destroy: () => s.destroy()
      }
    }
  },
  {
    id: 'spotlight',
    label: 'Spotlight',
    scopes: ELEMENT,
    schema: spotlightSchema,
    create: (fx, el) => spotlight(fx, { target: need(el, 'spotlight') })
  },
  {
    id: 'dissolve',
    label: 'Dissolve',
    scopes: ELEMENT,
    schema: dissolveSchema,
    create: (fx, el) => dissolve(fx, need(el, 'dissolve'))
  },
  {
    id: 'ripple',
    label: 'Ripple',
    scopes: ELEMENT,
    schema: rippleSchema,
    create: (fx, el) => ripple(fx, need(el, 'ripple'))
  },
  {
    id: 'reveal',
    label: 'Reveal',
    scopes: ELEMENT,
    schema: revealSchema,
    create: (fx, el) => reveal(fx, need(el, 'reveal'))
  },
  {
    id: 'develop',
    label: 'Develop',
    scopes: ELEMENT,
    schema: developSchema,
    create: (fx, el) => develop(fx, { target: need(el, 'develop') })
  },
  {
    id: 'textStagger',
    label: 'Text stagger',
    scopes: ELEMENT,
    schema: textStaggerSchema,
    create: (fx, el) => textStagger(fx, { target: need(el, 'textStagger') })
  },
  {
    id: 'glow',
    label: 'Glow',
    scopes: ELEMENT,
    schema: glowSchema,
    create(fx, el) {
      const g = glow(fx, need(el, 'glow'))
      return {
        params: g.layer.params,
        get enabled() {
          return g.enabled
        },
        set enabled(v: boolean) {
          g.enabled = v
        },
        destroy: () => g.destroy()
      }
    }
  },
  motionDef
]
