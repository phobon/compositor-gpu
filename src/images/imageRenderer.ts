import type { RenderPass } from '../gpu/frame'
import type { Scene } from '../scene/scene'
import { log } from '../util/log'

/**
 * Textured-quad pass for <img>/<canvas>/background-image.
 *
 * SCAFFOLD: the pipeline mirrors BoxPass (instanced quads) but samples a
 * texture instead of an SDF fill. v1 work: upload each source to a texture
 * (or a shared atlas for many small images), map object-fit -> UV, and draw.
 * Left as a no-op pass so the renderer wiring is complete and testable.
 */
export class ImagePass implements RenderPass {
  readonly layer = 'images' as const
  private warned = false

  upload(scene: Scene): void {
    if (!this.warned && scene.images.length > 0) {
      this.warned = true
      log.info(`ImagePass: ${scene.images.length} images pending (scaffold)`)
    }
  }

  draw(_encoder: GPURenderPassEncoder): void {}

  destroy(): void {}
}
