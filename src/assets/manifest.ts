import type { BakedFace } from '../text/slug/baked'
import type { TextureColor } from './texture_file'

// The baked-asset manifest (M5f; tools/bake.ts): what
// `createCompositor({ assets })` points at. Fonts (text/slug/baked.ts),
// svg files (assets/vector_file.ts), effect-input textures
// (assets/texture_file.ts) and distance-field masks (assets/
// mask_file.ts); each file loads when a page first needs it.

/** One baked svg file in a manifest. */
export interface BakedSvgEntry {
  /** The URL pages use for it (an img's src), relative to the page's
   * origin, e.g. "/icons/star.svg". */
  src: string
  /** The baked file, relative to the manifest. */
  url: string
  shapes: number
  bytes: number
}

/** One baked effect-input texture in a manifest (fx.texture(name)). */
export interface BakedTextureEntry {
  name: string
  /** The baked file, relative to the manifest. */
  url: string
  width: number
  height: number
  levels: number
  color: TextureColor
  bytes: number
}

/** One baked distance-field mask in a manifest (fx.sdf(el, { mask })). */
export interface BakedMaskEntry {
  name: string
  /** The baked file, relative to the manifest. */
  url: string
  width: number
  height: number
  /** viewBox units. */
  spread: number
  bytes: number
}

export interface BakedManifest {
  version: number
  fonts?: BakedFace[]
  svgs?: BakedSvgEntry[]
  textures?: BakedTextureEntry[]
  masks?: BakedMaskEntry[]
}

const loads = new Map<string, Promise<BakedManifest>>()

/** Fetch a manifest (absolute URL), once per URL for the page. */
export function fetchManifest(href: string): Promise<BakedManifest> {
  let p = loads.get(href)
  if (!p) {
    p = fetch(href).then((r) =>
      r.ok
        ? (r.json() as Promise<BakedManifest>)
        : Promise.reject(new Error(`${r.status} ${r.statusText}`))
    )
    loads.set(href, p)
  }
  return p
}
