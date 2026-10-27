import { fetchManifest } from '../assets/manifest'
import { type BakedMaskHeader, parseBakedMask } from '../assets/mask_file'
import { log } from '../util/log'
import { type FieldSource, FX_SDF_BYTES } from './sdf'

// A baked distance-field mask placed over an element (M5f;
// `fx.sdf(el, { mask })`): the field an svg's shape had offline
// (assets/mask_file.ts), mapped onto the element's content box per the
// svg's viewBox and preserveAspectRatio, read by passes and layers with
// `sdf(p)` exactly as a live field. Nothing is isolated or rebuilt: each
// frame only the placement (rect, and the viewBox -> CSS px scale the
// stored distances take) is refreshed.

/** The viewBox -> content box map's scale and offset (CSS px), per
 * preserveAspectRatio; `none` scales the distances by the smaller axis. */
export function maskPlacement(
  h: BakedMaskHeader,
  w: number,
  hh: number
): { sx: number; sy: number; tx: number; ty: number; k: number } {
  const [vx, vy, vw, vh] = h.viewBox
  const sx = w / Math.max(vw, 1e-9)
  const sy = hh / Math.max(vh, 1e-9)
  if (h.align === 'none') {
    return { sx, sy, tx: 0 - vx * sx, ty: 0 - vy * sy, k: Math.min(sx, sy) }
  }
  const s = h.slice ? Math.max(sx, sy) : Math.min(sx, sy)
  const at = (a: string): number => (a === 'Min' ? 0 : a === 'Max' ? 1 : 0.5)
  return {
    sx: s,
    sy: s,
    tx: (w - vw * s) * at(h.align.slice(1, 4)) - vx * s + 0,
    ty: (hh - vh * s) * at(h.align.slice(5, 8)) - vy * s + 0,
    k: s
  }
}

export class MaskField implements FieldSource {
  ready = false
  builds = 0
  /** The field's reach right now, CSS px. */
  spread = 0
  resolution = 0
  private version = 0
  private header: BakedMaskHeader | null = null
  private texture: GPUTexture | null = null
  private placeholder: GPUTexture | null = null
  private readonly info: GPUBuffer
  private readonly infoData = new Float32Array(FX_SDF_BYTES / 4)
  private last = ''
  private destroyed = false

  constructor(
    private readonly device: GPUDevice,
    assets: string | null,
    readonly el: Element,
    readonly name: string,
    private readonly wake: () => void
  ) {
    this.info = device.createBuffer({
      label: `fx:mask:${name}`,
      size: FX_SDF_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    device.queue.writeBuffer(this.info, 0, this.infoData)
    void this.load(assets)
  }

  private async load(assets: string | null): Promise<void> {
    try {
      if (!assets) {
        throw new Error('no assets manifest (createCompositor({ assets }))')
      }
      const href = new URL(assets, document.baseURI).href
      const m = await fetchManifest(href)
      const e = (m.masks ?? []).find((x) => x.name === this.name)
      if (!e) {
        throw new Error(`not in ${assets}`)
      }
      const r = await fetch(new URL(e.url, href).href)
      if (!r.ok) {
        throw new Error(`${r.status} ${r.statusText}`)
      }
      const { header, deflated } = parseBakedMask(await r.arrayBuffer())
      const half = new Uint8Array(
        await new Response(
          new Blob([deflated as Uint8Array<ArrayBuffer>])
            .stream()
            .pipeThrough(new DecompressionStream('deflate'))
        ).arrayBuffer()
      )
      if (this.destroyed) {
        return
      }
      if (half.length < header.width * header.height * 2) {
        throw new Error('texels end early')
      }
      const texture = this.device.createTexture({
        label: `fx:mask:${this.name}`,
        size: [header.width, header.height],
        format: 'r16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      })
      this.device.queue.writeTexture(
        { texture },
        half as Uint8Array<ArrayBuffer>,
        { bytesPerRow: header.width * 2, rowsPerImage: header.height },
        [header.width, header.height]
      )
      this.texture = texture
      this.header = header
      this.resolution = Math.max(header.width, header.height)
      this.ready = true
      this.builds = 1
      this.version++
      this.last = ''
      this.wake()
    } catch (err) {
      log.warn(
        `fx mask "${this.name}" not loaded (${(err as Error).message}); its sdf() reads as empty`
      )
    }
  }

  /** Each frame: place the field over the element's content box. */
  check(_key: string): void {
    const h = this.header
    if (!h || this.destroyed) {
      return
    }
    const r = this.el.getBoundingClientRect()
    const s = getComputedStyle(this.el)
    const px = (v: string): number => Number.parseFloat(v) || 0
    const l = px(s.borderLeftWidth) + px(s.paddingLeft)
    const t = px(s.borderTopWidth) + px(s.paddingTop)
    const w = r.width - l - px(s.borderRightWidth) - px(s.paddingRight)
    const hh = r.height - t - px(s.borderBottomWidth) - px(s.paddingBottom)
    const p = maskPlacement(h, Math.max(w, 0), Math.max(hh, 0))
    const x = r.left + window.scrollX + l
    const y = r.top + window.scrollY + t
    const [bx, by, bw, bh] = h.box
    const d = this.infoData
    d[0] = x + p.tx + bx * p.sx
    d[1] = y + p.ty + by * p.sy
    d[2] = bw * p.sx
    d[3] = bh * p.sy
    d[4] = 1
    d[5] = h.spread * p.k
    d[6] = p.k
    this.spread = d[5]
    const key = d.join()
    if (key !== this.last) {
      this.last = key
      this.device.queue.writeBuffer(this.info, 0, d)
    }
  }

  rebuild(): void {}

  get generation(): number {
    return this.version
  }

  view(): GPUTextureView {
    if (this.texture) {
      return this.texture.createView()
    }
    this.placeholder ??= this.device.createTexture({
      label: 'fx:mask-none',
      size: [1, 1],
      format: 'r16float',
      usage: GPUTextureUsage.TEXTURE_BINDING
    })
    return this.placeholder.createView()
  }

  get infoBuffer(): GPUBuffer {
    return this.info
  }

  destroy(): void {
    this.destroyed = true
    this.texture?.destroy()
    this.placeholder?.destroy()
    this.info.destroy()
  }
}
