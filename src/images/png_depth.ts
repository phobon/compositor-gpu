// 16-bit PNGs: Chrome decodes them to a half-float bitmap, and uploading
// that with copyExternalImageToTexture into an rgba8unorm texture crashes
// the tab under SwiftShader. Their bit depth is in the IHDR chunk (byte
// 24), so the source's first bytes are read once (from the HTTP cache, as
// the <img> already loaded it) and such sources are converted to 8 bits
// through a 2D canvas before upload.

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const HEAD = 26
const cache = new Map<string, Promise<boolean>>()

/** Could `url` be a PNG? (extension, data: or blob: URL) */
export function maybePng(url: string): boolean {
  if (url.startsWith('data:')) {
    return url.startsWith('data:image/png')
  }
  if (url.startsWith('blob:')) {
    return true
  }
  const path = url.split(/[?#]/)[0] ?? ''
  return /\.png$/i.test(path)
}

/** True when the first bytes are a PNG whose IHDR says 16 bits/channel. */
export function isPng16Header(b: Uint8Array): boolean {
  if (b.length < 25) {
    return false
  }
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (b[i] !== PNG_SIG[i]) {
      return false
    }
  }
  // Length (4) then 'IHDR' at 12..16; width, height, then bit depth.
  const ihdr = String.fromCharCode(
    b[12] ?? 0,
    b[13] ?? 0,
    b[14] ?? 0,
    b[15] ?? 0
  )
  return ihdr === 'IHDR' && b[24] === 16
}

async function head(url: string): Promise<Uint8Array | null> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    const meta = url.slice(0, comma)
    const body = url.slice(comma + 1, comma + 1 + 64)
    if (!meta.endsWith(';base64')) {
      return null
    }
    const bin = atob(body.slice(0, 48))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  }
  const res = await fetch(url, { cache: 'force-cache' })
  if (!res.ok || !res.body) {
    return null
  }
  const reader = res.body.getReader()
  const out = new Uint8Array(HEAD)
  let n = 0
  while (n < HEAD) {
    const { done, value } = await reader.read()
    if (done || !value) {
      break
    }
    const take = Math.min(value.length, HEAD - n)
    out.set(value.subarray(0, take), n)
    n += take
  }
  void reader.cancel().catch(() => {})
  return out.subarray(0, n)
}

/** Whether `url` is a 16-bit PNG (cached per URL; false when it can't be
 * read, e.g. cross-origin without CORS, whose upload fails anyway). */
export function isPng16(url: string): Promise<boolean> {
  if (!maybePng(url)) {
    return Promise.resolve(false)
  }
  let p = cache.get(url)
  if (!p) {
    p = head(url)
      .then((b) => (b ? isPng16Header(b) : false))
      .catch(() => false)
    cache.set(url, p)
  }
  return p
}

/** `bitmap` redrawn into an 8-bit-per-channel 2D canvas. */
export function to8Bit(
  bitmap: ImageBitmap
): OffscreenCanvas | HTMLCanvasElement | null {
  const w = bitmap.width
  const h = bitmap.height
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h })
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null
  if (!ctx) {
    return null
  }
  ctx.drawImage(bitmap, 0, 0)
  return canvas
}
