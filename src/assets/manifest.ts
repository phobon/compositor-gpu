import type { BakedFace } from '../text/slug/baked'

// The baked-asset manifest (M5f; tools/bake.ts): what
// `createCompositor({ assets })` points at. Fonts (text/slug/baked.ts)
// and svg files (assets/vector_file.ts); each file loads when a page
// first needs it.

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

export interface BakedManifest {
  version: number
  fonts?: BakedFace[]
  svgs?: BakedSvgEntry[]
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
