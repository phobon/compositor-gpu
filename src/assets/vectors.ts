import { log } from '../util/log'
import { fetchManifest } from './manifest'
import { type BakedSvg, decodeBakedSvg } from './vector_file'

// The baked svg files of an asset manifest (M5f), for
// `<img data-gpu-vector>`: looked up by the img's resolved src, each file
// fetched the first time an img needs it.

interface Entry {
  href: string
  svg: BakedSvg | null
  loaded: boolean
  waiting: Map<Element, () => void>
}

export class VectorStore {
  /** Absolute src -> entry; null while the manifest loads. */
  private entries: Map<string, Entry> | null = null
  private waitingManifest = new Map<Element, () => void>()
  /** Loads in flight (the manifest, files). */
  pending = 1

  constructor(url: string) {
    const href = new URL(url, document.baseURI).href
    fetchManifest(href)
      .then((m) => {
        const entries = new Map<string, Entry>()
        for (const s of m.svgs ?? []) {
          entries.set(new URL(s.src, document.baseURI).href, {
            href: new URL(s.url, href).href,
            svg: null,
            loaded: false,
            waiting: new Map()
          })
        }
        this.entries = entries
        if (entries.size) {
          log.info(`assets: ${entries.size} baked svg(s) in ${url}`)
        }
      })
      .catch(() => {
        // SlugText logs a missing manifest once.
        this.entries = new Map()
      })
      .finally(() => {
        this.pending--
        const w = this.waitingManifest
        this.waitingManifest = new Map()
        for (const f of w.values()) {
          f()
        }
      })
  }

  /**
   * The baked svg for an img src (absolute), 'pending' while the
   * manifest or the file loads (`ready` is called once it has, once per
   * element), or null when there is none (the img draws as an image).
   */
  lookup(
    src: string,
    el: Element,
    ready: () => void
  ): BakedSvg | 'pending' | null {
    if (!this.entries) {
      this.waitingManifest.set(el, ready)
      return 'pending'
    }
    const e = this.entries.get(src)
    if (!e) {
      return null
    }
    if (e.loaded) {
      return e.svg
    }
    const first = e.waiting.size === 0
    e.waiting.set(el, ready)
    if (first) {
      this.pending++
      fetch(e.href)
        .then((r) =>
          r.ok
            ? r.arrayBuffer()
            : Promise.reject(new Error(`${r.status} ${r.statusText}`))
        )
        .then((buf) => {
          e.svg = decodeBakedSvg(buf)
        })
        .catch((err: unknown) => {
          log.warn(
            `could not load baked svg ${e.href} (${(err as Error).message}); drawing ${src} as an image`
          )
        })
        .finally(() => {
          e.loaded = true
          this.pending--
          const w = e.waiting
          e.waiting = new Map()
          for (const f of w.values()) {
            f()
          }
        })
    }
    return 'pending'
  }
}
