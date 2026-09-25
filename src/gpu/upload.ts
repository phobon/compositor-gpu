import { log } from '../util/log'

const reported = new Set<string>()

/**
 * Set once a canvas-sourced upload has failed validation. Chrome imports a
 * canvas into WebGPU through its GPU-side shared image, and on some
 * configurations (seen: headless Chromium on macOS with the SwiftShader
 * WebGPU fallback, where the 2D canvas is Metal-backed) that import yields
 * an "[Invalid Texture]" source and the copy is dropped. Pixels read back
 * with getImageData never take that path.
 */
let canvasImportBroken = false

type Canvas = HTMLCanvasElement | OffscreenCanvas

const isCanvas = (src: GPUImageCopyExternalImageSource): src is Canvas =>
  (typeof HTMLCanvasElement !== 'undefined' &&
    src instanceof HTMLCanvasElement) ||
  (typeof OffscreenCanvas !== 'undefined' && src instanceof OffscreenCanvas)

/** The canvas's pixels as ImageData, or null when it has no 2D context
 * (a WebGL canvas) or is empty. */
function readback(canvas: Canvas): ImageData | null {
  const ctx = (canvas as HTMLCanvasElement).getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null
  if (!ctx || canvas.width === 0 || canvas.height === 0) {
    return null
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

function describe(src: GPUImageCopyExternalImageSource): string {
  const tag = Object.prototype.toString.call(src).slice(8, -1)
  const s = src as { width?: number; height?: number }
  const img = src as Partial<HTMLImageElement>
  const extra =
    img.currentSrc !== undefined
      ? ` complete=${img.complete} natural=${img.naturalWidth}x${img.naturalHeight} src=${img.currentSrc.slice(0, 80)}`
      : ''
  return `${tag} ${s.width ?? '?'}x${s.height ?? '?'}${extra}`
}

/**
 * `queue.copyExternalImageToTexture` under a validation error scope. A
 * failed upload otherwise surfaces only as Dawn's "[Invalid Texture]"
 * message with no hint of which source it came from; this logs the source
 * (type, size, load state) and the destination's label, once per label.
 *
 * Canvas sources: once one has failed (see `canvasImportBroken`) every
 * canvas upload goes through `getImageData` instead, and the failed copy is
 * re-issued that way immediately, so the first frame self-heals.
 */
export function copyExternalImage(
  device: GPUDevice,
  source: GPUImageCopyExternalImage,
  dest: GPUImageCopyTextureTagged,
  size: GPUExtent3DStrict
): void {
  const src = source.source
  if (canvasImportBroken && isCanvas(src)) {
    const data = readback(src)
    if (data) {
      device.queue.copyExternalImageToTexture(
        { ...source, source: data },
        dest,
        size
      )
      return
    }
  }
  device.pushErrorScope('validation')
  device.queue.copyExternalImageToTexture(source, dest, size)
  void device.popErrorScope().then((e) => {
    if (!e) {
      return
    }
    const label = dest.texture.label || '(unlabeled)'
    if (isCanvas(src)) {
      const data = readback(src)
      if (data) {
        if (!canvasImportBroken) {
          canvasImportBroken = true
          log.warn(
            `canvas -> WebGPU import failed ("${label}"); canvas uploads now go through getImageData`
          )
        }
        device.queue.copyExternalImageToTexture(
          { ...source, source: data },
          dest,
          size
        )
        return
      }
    }
    if (reported.has(label)) {
      return
    }
    reported.add(label)
    log.error(`upload to "${label}" from ${describe(src)} failed: ${e.message}`)
  })
}
