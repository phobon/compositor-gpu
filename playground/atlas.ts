// typegpu reads process.env at evaluation: the shim must run first.
import '@/util/env'
import './nav'
import { type AtlasRect, ImageAtlas } from '@/images/image_atlas'

// ImageAtlas checks for test/atlas/run.ts: growth keeps pixels, a full
// atlas repacks the space a grow wasted, and unused entries are evicted
// (repacked, their pixels kept) when new ones need the room. Each check
// is [name, ok, detail].

type Check = [string, boolean, string]

async function run(): Promise<Check[]> {
  const adapter = await navigator.gpu?.requestAdapter()
  const device = await adapter?.requestDevice()
  if (!device) {
    return [['webgpu', false, 'no device']]
  }
  const atlas = new ImageAtlas(device)
  const N = 1024
  const tile = (r: number, g: number, b: number): OffscreenCanvas => {
    const c = new OffscreenCanvas(N, N)
    const x = c.getContext('2d')
    if (x) {
      x.fillStyle = `rgb(${r},${g},${b})`
      x.fillRect(0, 0, N, N)
    }
    return c
  }
  const pixel = async (rect: AtlasRect | null): Promise<number[]> => {
    const tex = (atlas as unknown as { texture: GPUTexture | null }).texture
    if (!rect || !tex) {
      return []
    }
    const buf = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    })
    const enc = device.createCommandEncoder()
    enc.copyTextureToBuffer(
      { texture: tex, origin: [rect.x + 10, rect.y + 10] },
      { buffer: buf, bytesPerRow: 256 },
      [1, 1]
    )
    device.queue.submit([enc.finish()])
    await buf.mapAsync(GPUMapMode.READ)
    const p = Array.from(new Uint8Array(buf.getMappedRange()).slice(0, 4))
    buf.unmap()
    buf.destroy()
    return p
  }
  // Where a canvas -> WebGPU import fails (headless macOS with
  // SwiftShader), the first canvas upload is re-issued from getImageData
  // once its error scope resolves (gpu/upload.ts): let that land.
  const settle = async (): Promise<void> => {
    await device.queue.onSubmittedWorkDone()
    await new Promise((r) => setTimeout(r, 100))
    await device.queue.onSubmittedWorkDone()
  }
  const same = (a: number[], b: number[]): boolean =>
    a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? 0)) <= 1)
  const checks: Check[] = []

  atlas.beginUse()
  const first = atlas.size
  for (let i = 0; i < 9; i++) {
    atlas.add(tile(i * 20, 100, 200), N, N, `a${i}`)
  }
  await settle()
  const a0 = await pixel(atlas.get('a0'))
  checks.push([
    'grow keeps pixels',
    atlas.size > first && same(a0, [0, 100, 200, 255]),
    `size ${first} -> ${atlas.size}, a0 ${a0}`
  ])
  checks.push([
    'full atlas repacks',
    atlas.count === 9,
    `${atlas.count} of 9 1024px entries in ${atlas.size}px`
  ])
  const refused = atlas.add(tile(1, 2, 3), N, N, 'x')
  checks.push([
    'in-use entries are never evicted',
    refused === null && atlas.count === 9,
    `tenth ${refused ? 'packed' : 'refused'}, ${atlas.count} entries`
  ])
  // Two rounds use only a4: the rest become evictable.
  atlas.beginUse()
  atlas.get('a4')
  atlas.beginUse()
  atlas.get('a4')
  let added = 0
  for (let i = 0; i < 8; i++) {
    if (atlas.add(tile(250, i * 30, 0), N, N, `b${i}`)) {
      added++
    }
  }
  await settle()
  const a4 = await pixel(atlas.get('a4'))
  const b7 = await pixel(atlas.get('b7'))
  checks.push([
    'unused entries evicted',
    added === 8 && atlas.get('a0') === null && atlas.count === 9,
    `${added} of 8 added, a0 ${atlas.get('a0') ? 'kept' : 'evicted'}, ${atlas.count} entries`
  ])
  checks.push([
    'survivors keep pixels',
    same(a4, [80, 100, 200, 255]) && same(b7, [250, 210, 0, 255]),
    `a4 ${a4}, b7 ${b7}`
  ])
  atlas.destroy()
  device.destroy()
  return checks
}

const w = window as unknown as { __atlas?: Promise<Check[]> }
w.__atlas = run()
