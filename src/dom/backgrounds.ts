import type { BoxRecord, Corners, ImageRecord, Rect } from '../scene/records'
import type { Layer } from '../types'
import { splitTopLevel } from '../util/css'
import { backgroundLayers } from './gradient'
import {
  backgroundSize,
  boxInset,
  insetCorners,
  layerClipInset,
  layerGradient,
  mapBackgroundPosition,
  recordRadii
} from './styles'
import { type Placement, placementAabb, subPlacement } from './transform'

/**
 * The URL of a `background-image` layer (one entry of the list), or null
 * when it isn't a `url(...)` (a gradient, `none`, or unparsable).
 */
export function urlOfLayer(layer: string | undefined): string | null {
  if (!layer || layer === 'none') {
    return null
  }
  const match = /^url\((.*)\)$/is.exec(layer.trim())
  if (!match) {
    return null
  }
  let inner = (match[1] ?? '').trim()
  if (
    (inner.startsWith('"') && inner.endsWith('"')) ||
    (inner.startsWith("'") && inner.endsWith("'"))
  ) {
    inner = inner.slice(1, -1)
  }
  return inner || null
}

/** background-size -> ImageRecord.objectFit: cover/contain as such,
 * `auto` the natural size ('none'), `100% 100%` 'fill'; other lengths are
 * 'none' with `bgSize` (see backgroundSize). */
export function mapBackgroundSize(
  size: string
): 'fill' | 'contain' | 'cover' | 'none' {
  const s = size.trim()
  if (s === 'cover') {
    return 'cover'
  }
  if (s === 'contain') {
    return 'contain'
  }
  if (s === '100% 100%') {
    return 'fill'
  }
  return 'none'
}

/** background-repeat -> whether the image tiles. Only exact `no-repeat`
 * turns tiling off; `repeat-x`/`repeat-y`/`space`/`round` are approximated
 * as tiling (fit 'none' repeats both axes; see imageRenderer.ts). */
export function mapBackgroundRepeat(repeat: string): boolean {
  return repeat.trim() !== 'no-repeat'
}

/** url -> <img> (loading, loaded or failed), cached across calls. */
const cache = new Map<string, HTMLImageElement>()

interface Waiter {
  owner: object
  onReady: () => void
}

/** url -> callbacks to run when it settles, one per waiting element (a
 * re-read replaces the element's entry). Cleared on load or error. */
const waiters = new Map<string, Map<Element, Waiter>>()

function settle(url: string, loaded: boolean): void {
  const w = waiters.get(url)
  waiters.delete(url)
  if (!w || !loaded) {
    return
  }
  for (const { onReady } of w.values()) {
    onReady()
  }
}

/**
 * Returns the loaded image for `url` if it's ready to sample, else starts
 * (or continues) loading it and returns null. `crossOrigin` is set before
 * `src` so cross-origin images come back CORS-clean — WebGPU's
 * `copyExternalImageToTexture` refuses to upload a tainted image, which the
 * image pass can only surface as a logged failure, not a thrown error.
 * While it loads, `onReady` is registered for (`owner`, `el`) and runs once
 * when it finishes; nothing runs if it fails (a failed url stays cached and
 * is not retried). `disposeBackgrounds(owner)` drops an owner's callbacks.
 */
export function loadBackground(
  url: string,
  owner: object,
  el: Element,
  onReady: () => void
): HTMLImageElement | null {
  let img = cache.get(url)
  if (!img) {
    img = new Image()
    img.crossOrigin = 'anonymous'
    img.addEventListener('load', () => settle(url, true), { once: true })
    img.addEventListener('error', () => settle(url, false), { once: true })
    img.src = url
    cache.set(url, img)
  }
  if (img.complete) {
    return img.naturalWidth > 0 ? img : null
  }
  let w = waiters.get(url)
  if (!w) {
    w = new Map()
    waiters.set(url, w)
  }
  w.set(el, { owner, onReady })
  return null
}

/** Drop every pending background callback registered by `owner`. */
export function disposeBackgrounds(owner: object): void {
  for (const [url, w] of waiters) {
    for (const [el, waiter] of w) {
      if (waiter.owner === owner) {
        w.delete(el)
      }
    }
    if (w.size === 0) {
      waiters.delete(url)
    }
  }
}

/** Layer `i` of a comma list; the list repeats to cover every layer. */
function layerValue(list: string, i: number, fallback: string): string {
  const parts = splitTopLevel(list, ',')
  return (
    (parts.length ? (parts[i % parts.length] ?? '') : '').trim() || fallback
  )
}

/** The element's radii inset to the painting area (`ci`, per side):
 * circular as insetCorners does, elliptical per axis. */
function clipRadii(
  s: CSSStyleDeclaration,
  place: Placement,
  ci: [number, number, number, number]
): { radius: Corners; radiusY?: Corners } {
  const rr = recordRadii(s, {
    x: 0,
    y: 0,
    width: place.local.w,
    height: place.local.h
  })
  if (!rr.radiusY) {
    return { radius: insetCorners(rr.radius, ci) }
  }
  const [t, r, b, l] = ci
  const x = rr.radius
  const y = rr.radiusY
  return {
    radius: [
      Math.max(0, x[0] - l),
      Math.max(0, x[1] - r),
      Math.max(0, x[2] - r),
      Math.max(0, x[3] - l)
    ],
    radiusY: [
      Math.max(0, y[0] - t),
      Math.max(0, y[1] - t),
      Math.max(0, y[2] - b),
      Math.max(0, y[3] - b)
    ]
  }
}

/**
 * Build an ImageRecord for `background-image` layer `layer` (index into
 * `layers`, top-most first), or null when it isn't a url or is still
 * loading. `place` is the element's border-box placement (see
 * transform.ts).
 *
 * The record's local box is the layer's painting area (`background-clip`,
 * border-box by default) and its radii follow that box (outer radii minus
 * the insets). The tile/cover/contain area is the `background-origin` box
 * (padding-box by default), carried as `originInset` relative to the local
 * box. `background-clip`, `-origin`, `-size`, `-position` and `-repeat`
 * are read at the layer's index;
 * `text` clips as border-box. `onReady` is called once the image finishes
 * loading, so the caller can re-read the element (see loadBackground for
 * `owner`).
 */
export function readBackgroundImage(
  el: Element,
  s: CSSStyleDeclaration,
  id: number,
  clip: Rect | null,
  owner: object,
  onReady: () => void,
  place: Placement,
  layers: readonly string[],
  layer: number
): ImageRecord | null {
  if (s.visibility !== 'visible') {
    return null
  }
  const url = urlOfLayer(layers[layer])
  if (!url) {
    return null
  }
  const img = loadBackground(url, owner, el, onReady)
  if (!img) {
    return null
  }
  const clipBox = layerValue(s.backgroundClip, layer, 'border-box')
  const originBox = layerValue(s.backgroundOrigin, layer, 'padding-box')
  const ci = boxInset(s, clipBox)
  const oi = boxInset(s, originBox)
  const area = subPlacement(
    place,
    ci[3],
    ci[0],
    Math.max(0, place.local.w - ci[1] - ci[3]),
    Math.max(0, place.local.h - ci[0] - ci[2])
  )
  const origin: [number, number, number, number] = [
    oi[0] - ci[0],
    oi[1] - ci[1],
    oi[2] - ci[2],
    oi[3] - ci[3]
  ]
  if (
    area.local.w <= 0 ||
    area.local.h <= 0 ||
    area.local.w - origin[1] - origin[3] <= 0 ||
    area.local.h - origin[0] - origin[2] <= 0
  ) {
    return null
  }
  const size = layerValue(s.backgroundSize, layer, 'auto')
  const bgSize = backgroundSize(
    size,
    area.local.w - origin[1] - origin[3],
    area.local.h - origin[0] - origin[2]
  )
  return {
    kind: 'image',
    id,
    rect: placementAabb(area),
    xform: area.xform,
    local: area.local,
    source: img,
    objectFit: mapBackgroundSize(size),
    ...(bgSize ? { bgSize } : {}),
    position: mapBackgroundPosition(
      layerValue(s.backgroundPosition, layer, '0% 0%')
    ),
    repeat: mapBackgroundRepeat(
      layerValue(s.backgroundRepeat, layer, 'repeat')
    ),
    ...clipRadii(s, place, ci),
    ...(origin.some((v) => v !== 0) ? { originInset: origin } : {}),
    opacity: 1,
    z: 0,
    clip,
    dynamic: false
  }
}

/**
 * The `background-image` layers above the element's own box record, in
 * paint order (bottom-most first): url() layers as ImageRecords, gradient
 * layers as border-less BoxRecords (the bottom layer's gradient, if any,
 * is already in `box`). When one of them reaches into the border area,
 * the border moves from `box` to a record of its own after them (CSS
 * paints the border over every background layer).
 */
export function backgroundLayerRecords(
  box: BoxRecord | undefined,
  s: CSSStyleDeclaration,
  place: Placement,
  rect: Rect,
  clip: Rect | null,
  alloc: () => number,
  layers: ReadonlySet<Layer>,
  readImage: (bgLayers: readonly string[], i: number) => ImageRecord | null
): (BoxRecord | ImageRecord)[] {
  if (s.visibility !== 'visible' || rect.width <= 0 || rect.height <= 0) {
    return []
  }
  const bgLayers = backgroundLayers(s.backgroundImage)
  const out: (BoxRecord | ImageRecord)[] = []
  let reaches = false
  const pad = boxInset(s, 'padding-box')
  const padW = place.local.w - pad[1] - pad[3]
  const padH = place.local.h - pad[0] - pad[2]
  for (let i = bgLayers.length - 1; i >= 0; i--) {
    const layer = bgLayers[i] ?? ''
    if (layer.startsWith('url(')) {
      const img = layers.has('images') ? readImage(bgLayers, i) : null
      if (img) {
        img.clip = clip
        out.push(img)
        reaches ||= img.local.w > padW + 0.01 || img.local.h > padH + 0.01
      }
      continue
    }
    if (i === bgLayers.length - 1 || !layers.has('boxes')) {
      continue
    }
    const border = box?.border ?? null
    const gradient = layerGradient(
      s,
      bgLayers,
      i,
      border,
      place.local.w,
      place.local.h
    )
    if (!gradient) {
      continue
    }
    const inset = layerClipInset(s, i)
    const clear = { r: 0, g: 0, b: 0, a: 0 }
    out.push({
      kind: 'box',
      id: alloc(),
      rect,
      xform: place.xform,
      local: place.local,
      ...recordRadii(s, {
        x: 0,
        y: 0,
        width: place.local.w,
        height: place.local.h
      }),
      fill: clear,
      gradient,
      ...(inset ? { bgInset: inset } : {}),
      // The widths place the gradient box; nothing of the border paints.
      border: border && {
        widths: border.widths,
        colors: [clear, clear, clear, clear],
        styles: border.styles
      },
      opacity: 1,
      z: 0,
      clip
    })
    reaches ||= inset === null && gradient.repeat?.some(Boolean) === true
  }
  if (box?.border && reaches && out.length > 0) {
    const top: BoxRecord = {
      ...box,
      id: alloc(),
      fill: { r: 0, g: 0, b: 0, a: 0 },
      gradient: null
    }
    delete top.bgInset
    // Keep the widths: they place the box's own (bottom) gradient.
    const clear = { r: 0, g: 0, b: 0, a: 0 }
    box.border = {
      widths: box.border.widths,
      colors: [clear, clear, clear, clear],
      styles: box.border.styles
    }
    out.push(top)
  }
  return out
}
