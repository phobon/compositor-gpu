// Growable instance buffers (src/gpu/storage.ts) against a fake device.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StorageArray, type StorageDevice } from '../../src/gpu/storage'

// The usage flags are browser globals.
;(globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage ??= {
  STORAGE: 0x80,
  COPY_DST: 0x8
}

function fakeDevice() {
  const created: { size: number; destroyed: boolean }[] = []
  const writes: [number, number, number][] = []
  const device: StorageDevice = {
    createBuffer(desc) {
      const b = { size: desc.size, destroyed: false }
      created.push(b)
      return {
        destroy() {
          b.destroyed = true
        }
      } as unknown as GPUBuffer
    },
    queue: {
      writeBuffer: ((
        _buf: GPUBuffer,
        offset: number,
        _data: ArrayBuffer,
        dataOffset: number,
        size: number
      ) => {
        writes.push([offset, dataOffset ?? 0, size ?? 0])
      }) as GPUQueue['writeBuffer']
    }
  }
  return { device, created, writes }
}

test('first allocation takes the initial size, at least n', () => {
  const { device, created } = fakeDevice()
  const a = new StorageArray(device, 4, 16)
  assert.equal(a.ensure(3), true)
  assert.equal(a.capacity, 16)
  assert.equal(created[0]?.size, 16 * 4 * 4)
  const b = new StorageArray(device, 4, 16)
  b.ensure(40)
  assert.equal(b.capacity, 40)
})

test('grows by doubling, recreating the buffer and the CPU copy', () => {
  const { device, created } = fakeDevice()
  const a = new StorageArray(device, 2, 16)
  a.ensure(10)
  const before = a.f32
  assert.equal(a.ensure(16), false)
  assert.equal(a.f32, before)
  assert.equal(a.ensure(17), true)
  assert.equal(a.capacity, 32)
  assert.notEqual(a.f32, before)
  assert.equal(a.f32.length, 64)
  assert.equal(created[0]?.destroyed, true)
  assert.equal(created.length, 2)
})

test('the float and word views share bytes', () => {
  const { device } = fakeDevice()
  const a = new StorageArray(device, 4, 4)
  a.ensure(1)
  a.f32[0] = 1
  assert.equal(a.u32[0], 0x3f800000)
})

test('writes cover only the items asked for, in bytes', () => {
  const { device, writes } = fakeDevice()
  const a = new StorageArray(device, 8, 16)
  a.write(0, 3)
  assert.deepEqual(writes, [])
  a.ensure(10)
  a.write(0, 3)
  a.write(5, 2)
  a.write(7, 0)
  assert.deepEqual(writes, [
    [0, 0, 3 * 8 * 4],
    [5 * 8 * 4, 5 * 8 * 4, 2 * 8 * 4]
  ])
})

test('destroy releases the buffer; the next ensure starts over', () => {
  const { device, created } = fakeDevice()
  const a = new StorageArray(device, 1, 16)
  a.ensure(100)
  a.destroy()
  assert.equal(created[0]?.destroyed, true)
  assert.equal(a.buffer, null)
  assert.equal(a.ensure(1), true)
  assert.equal(a.capacity, 16)
})
