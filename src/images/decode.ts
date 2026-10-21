// Decoding an <img> for upload. createImageBitmap(img) decodes on the main
// thread, synchronously inside the call (54 ms of phobon.io's first frame
// for its six project webps; a 2400px webp ~250 ms headless), and img.decode()
// first doesn't change that. createImageBitmap(blob) decodes off the main
// thread, so the source is re-read from the HTTP cache (the <img> already
// loaded it) and decoded from the Blob. The fetch uses the normal cache
// rules, not 'force-cache': a cross-origin source with CORS is cached apart
// from the <img>'s own no-cors request (Vary: Origin), so 'force-cache'
// kept drawing a replaced image's old bytes while the page showed the new
// ones. Sources fetch can't read
// (a failed request) take the element path, except a cross-origin <img>
// loaded without CORS: the element is tainted too, so neither path can
// upload it (OpaqueImageError).

import { isPng16, isPng16Header, maybePng } from './png_depth'

export interface Decoded {
  bitmap: ImageBitmap
  /** A 16-bit PNG (see pngDepth.ts). */
  deep: boolean
}

async function fromBlob(url: string, img: HTMLImageElement): Promise<Decoded> {
  const res = await fetch(url, {
    credentials:
      img.crossOrigin === 'use-credentials' ? 'include' : 'same-origin'
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  const blob = await res.blob()
  const deep =
    maybePng(url) &&
    isPng16Header(new Uint8Array(await blob.slice(0, 26).arrayBuffer()))
  return { bitmap: await createImageBitmap(blob), deep }
}

/** `img`'s source is cross-origin, the <img> has no `crossorigin`
 * attribute and the bytes can't be fetched (no CORS headers). */
export class OpaqueImageError extends Error {}

const crossOrigin = (url: string): boolean => {
  const u = new URL(url, location.href)
  return (
    (u.protocol === 'http:' || u.protocol === 'https:') &&
    u.origin !== location.origin
  )
}

/** Decode `img`'s current source to an ImageBitmap, off the main thread
 * when its bytes can be fetched. */
export function decodeImage(img: HTMLImageElement): Promise<Decoded> {
  const url = img.currentSrc || img.src
  return fromBlob(url, img).catch((err: unknown) => {
    if (img.crossOrigin === null && crossOrigin(url)) {
      throw new OpaqueImageError(url, { cause: err })
    }
    return Promise.all([createImageBitmap(img), isPng16(url)]).then(
      ([bitmap, deep]) => ({ bitmap, deep })
    )
  })
}
