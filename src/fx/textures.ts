import { fetchManifest } from '../assets/manifest'
import {
  parseBakedTexture,
  splitLevels,
  unfilterLevels
} from '../assets/texture_file'
import { log } from '../util/log'

// Effect-input textures (M5f; docs/EFFECTS.md, Textures): images baked
// with their mip chains (tools/bake.ts, assets/texture_file.ts) that
// passes, layers and materials read by name. `fx.texture(name)` hands
// out a handle; `textures: { noise: fx.texture('noise') }` on an effect
// gives its WGSL `tex_noise(uv)`, `tex_noise_level(uv, lod)`,
// `tex_noise_size()` and `tex_noise_ready()`. A texture loads when an
// effect first uses it; until then (or when it can't load) it reads as
// transparent black and `_ready()` is false.

/** Textures one effect may read. */
export const MAX_TEXTURES = 4

/** A baked effect-input texture (Effects.texture). */
export interface Texture {
  readonly name: string
  /** Uploaded (its `tex_<name>_ready()` is true). */
  readonly loaded: boolean
  /** Resolves true once uploaded, false when it can't be (no manifest,
   * not in it, or the file failed). */
  readonly ready: Promise<boolean>
}

/** An effect's `textures` option: WGSL name -> texture. */
export type TextureInputs = Readonly<Record<string, Texture>>

const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/

class Slot implements Texture {
  loaded = false
  view: GPUTextureView
  width = 0
  height = 0
  levels = 0
  /** Bumped when `view` changes. */
  generation = 0
  texture: GPUTexture | null = null
  ready: Promise<boolean>
  started = false
  settle: (ok: boolean) => void = () => {}
  constructor(
    readonly name: string,
    placeholder: GPUTextureView
  ) {
    this.view = placeholder
    this.ready = new Promise((r) => {
      this.settle = r
    })
  }
}

/** A handle that never loads (inert effects). */
export function inertTexture(name: string): Texture {
  return { name, loaded: false, ready: Promise.resolve(false) }
}

/** The runtime's textures, by name (one per Effects runtime). */
export class TextureStore {
  private readonly slots = new Map<string, Slot>()
  private readonly placeholder: GPUTexture
  private readonly placeholderView: GPUTextureView
  readonly sampler: GPUSampler

  constructor(
    private readonly device: GPUDevice,
    /** The manifest URL (CompositorOptions.assets), or null. */
    private readonly assets: string | null,
    private readonly wake: () => void
  ) {
    this.placeholder = device.createTexture({
      label: 'fx-texture-none',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    })
    device.queue.writeTexture(
      { texture: this.placeholder },
      new Uint8Array(4),
      { bytesPerRow: 4 },
      [1, 1]
    )
    this.placeholderView = this.placeholder.createView()
    this.sampler = device.createSampler({
      label: 'fx-texture',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge'
    })
  }

  /** The handle for `name` (the same one each call). */
  get(name: string): Texture {
    let s = this.slots.get(name)
    if (!s) {
      s = new Slot(name, this.placeholderView)
      this.slots.set(name, s)
    }
    return s
  }

  /** This store's slot behind a handle, loading it on first use. */
  use(t: Texture): Slot | null {
    const s = this.slots.get(t.name)
    if (!s || s !== t) {
      return null
    }
    if (!s.started) {
      s.started = true
      void this.load(s)
    }
    return s
  }

  private async load(s: Slot): Promise<void> {
    try {
      if (!this.assets) {
        throw new Error('no assets manifest (createCompositor({ assets }))')
      }
      const href = new URL(this.assets, document.baseURI).href
      const m = await fetchManifest(href)
      const e = (m.textures ?? []).find((t) => t.name === s.name)
      if (!e) {
        throw new Error(`not in ${this.assets}`)
      }
      const r = await fetch(new URL(e.url, href).href)
      if (!r.ok) {
        throw new Error(`${r.status} ${r.statusText}`)
      }
      const { header, deflated } = parseBakedTexture(await r.arrayBuffer())
      const texels = new Uint8Array(
        await new Response(
          new Blob([deflated as Uint8Array<ArrayBuffer>])
            .stream()
            .pipeThrough(new DecompressionStream('deflate'))
        ).arrayBuffer()
      )
      const levels = splitLevels(header, texels)
      unfilterLevels(levels, header)
      const texture = this.device.createTexture({
        label: `fx-texture:${s.name}`,
        size: [header.width, header.height],
        mipLevelCount: header.levels,
        // Colour stays sRGB-encoded, as the page's pixels are in every
        // pass (the mips were filtered in linear light at bake time).
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      })
      levels.forEach((data, k) => {
        const w = Math.max(1, header.width >> k)
        const h = Math.max(1, header.height >> k)
        this.device.queue.writeTexture(
          { texture, mipLevel: k },
          data as Uint8Array<ArrayBuffer>,
          { bytesPerRow: w * 4, rowsPerImage: h },
          [w, h]
        )
      })
      s.texture = texture
      s.view = texture.createView()
      s.width = header.width
      s.height = header.height
      s.levels = header.levels
      s.loaded = true
      s.generation++
      s.settle(true)
      this.wake()
    } catch (err) {
      log.warn(
        `fx texture "${s.name}" not loaded (${(err as Error).message}); it reads as transparent`
      )
      s.settle(false)
    }
  }

  destroy(): void {
    for (const s of this.slots.values()) {
      s.texture?.destroy()
      s.settle(false)
    }
    this.slots.clear()
    this.placeholder.destroy()
  }
}

/** Check an effect's `textures` option; returns its entries in order. */
export function textureList(
  inputs: TextureInputs | undefined,
  owner: string
): [string, Texture][] {
  const list = Object.entries(inputs ?? {})
  if (list.length > MAX_TEXTURES) {
    throw new Error(
      `fx:${owner}: at most ${MAX_TEXTURES} textures (got ${list.length})`
    )
  }
  for (const [name] of list) {
    if (!IDENT.test(name)) {
      throw new Error(
        `fx:${owner}: texture name "${name}" is not a WGSL identifier`
      )
    }
  }
  return list
}

/**
 * WGSL for an effect's textures in bind group `group`: the info uniform
 * at `base`, the sampler at base + 1, texture k at base + 2 + k, and per
 * name its helpers. Values are as stored: straight alpha, colour
 * sRGB-encoded like the page's pixels.
 */
export function texturesWgsl(
  group: number,
  base: number,
  names: readonly string[]
): string {
  if (names.length === 0) {
    return ''
  }
  const decl = (b: number, rest: string): string =>
    `@group(${group}) @binding(${b}) ${rest}`
  return [
    decl(base, `var<uniform> fx_tex_info : array<vec4f, ${MAX_TEXTURES}>;`),
    decl(base + 1, 'var fx_tex_smp : sampler;'),
    ...names.map((n, k) =>
      [
        decl(base + 2 + k, `var fx_tex_${k} : texture_2d<f32>;`),
        `fn tex_${n}_level(uv : vec2f, lod : f32) -> vec4f {`,
        `  return textureSampleLevel(fx_tex_${k}, fx_tex_smp, uv, lod);`,
        '}',
        `fn tex_${n}(uv : vec2f) -> vec4f { return tex_${n}_level(uv, 0.0); }`,
        `fn tex_${n}_size() -> vec2f { return fx_tex_info[${k}].xy; }`,
        `fn tex_${n}_levels() -> f32 { return fx_tex_info[${k}].w; }`,
        `fn tex_${n}_ready() -> bool { return fx_tex_info[${k}].z > 0.5; }`
      ].join('\n')
    )
  ].join('\n')
}

/** Bind group layout entries for `n` textures from `base`. */
export function textureLayoutEntries(
  base: number,
  n: number,
  visibility: number
): GPUBindGroupLayoutEntry[] {
  if (n === 0) {
    return []
  }
  return [
    { binding: base, visibility, buffer: { type: 'uniform' } },
    { binding: base + 1, visibility, sampler: { type: 'filtering' } },
    ...Array.from(
      { length: n },
      (_, k): GPUBindGroupLayoutEntry => ({
        binding: base + 2 + k,
        visibility,
        texture: { sampleType: 'float' }
      })
    )
  ]
}

/** One effect's textures: their info uniform and current views. */
export class TextureBinding {
  private readonly info: GPUBuffer
  private readonly slots: Slot[]
  private written = -1

  constructor(
    private readonly device: GPUDevice,
    private readonly store: TextureStore,
    list: readonly [string, Texture][],
    label: string
  ) {
    this.slots = list.map(([name, t]) => {
      const s = store.use(t)
      if (!s) {
        throw new Error(
          `${label}: texture "${name}" is not from this effects runtime`
        )
      }
      return s
    })
    this.info = device.createBuffer({
      label: `${label}:textures`,
      size: MAX_TEXTURES * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
  }

  get count(): number {
    return this.slots.length
  }

  /** Changes when any view does (rebuild the bind group). */
  version(): number {
    return this.slots.reduce((n, s) => n + s.generation, 0)
  }

  /** The entries from `base` (writes the info uniform when stale). */
  entries(base: number): GPUBindGroupEntry[] {
    const v = this.version()
    if (v !== this.written) {
      this.written = v
      const d = new Float32Array(MAX_TEXTURES * 4)
      this.slots.forEach((s, k) => {
        d.set([s.width, s.height, s.loaded ? 1 : 0, s.levels], 4 * k)
      })
      this.device.queue.writeBuffer(this.info, 0, d)
    }
    return [
      { binding: base, resource: { buffer: this.info } },
      { binding: base + 1, resource: this.store.sampler },
      ...this.slots.map(
        (s, k): GPUBindGroupEntry => ({
          binding: base + 2 + k,
          resource: s.view
        })
      )
    ]
  }

  destroy(): void {
    this.info.destroy()
  }
}
