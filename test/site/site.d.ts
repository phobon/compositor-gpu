import type { SlugText } from '@/text/slug/rasterizer'
import type { Compositor, CompositorOptions } from '@/types'

declare global {
  interface Window {
    /** The compositor instance the site harness (or the target page itself,
     * with `--bundle-url`) creates for testing. */
    __site?: Compositor & { text: SlugText | null }
    /** Set by the injected bundle wrapper once the module has loaded. */
    __createCompositor?: (
      options: CompositorOptions
    ) => Promise<Compositor & { text: SlugText | null }>
  }
}
