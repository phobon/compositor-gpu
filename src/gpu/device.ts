import tgpu from 'typegpu'
import { log } from '../util/log'

export interface GpuContext {
  // TypeGPU root — the entry point for typed buffers/bind groups as we grow.
  root: { destroy(): void }
  device: GPUDevice
  canvas: HTMLCanvasElement
  context: GPUCanvasContext
  format: GPUTextureFormat
}

export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

/**
 * Initialise WebGPU through TypeGPU. Returns null (never throws) when WebGPU
 * is unavailable or adapter/device request fails — callers fall back to the
 * untouched page.
 */
export async function initGpu(
  canvas: HTMLCanvasElement
): Promise<GpuContext | null> {
  if (!webgpuAvailable()) {
    log.warn('WebGPU not available; passthrough')
    return null
  }
  try {
    // TypeGPU owns adapter+device negotiation and hands us a typed root.
    const root = (await tgpu.init()) as unknown as {
      destroy(): void
      device: GPUDevice
    }
    const device = root.device
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null
    if (!context) {
      log.warn('no webgpu canvas context; passthrough')
      root.destroy()
      return null
    }
    const format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: 'premultiplied' })
    return { root, device, canvas, context, format }
  } catch (err) {
    log.error('WebGPU init failed; passthrough', err)
    return null
  }
}
