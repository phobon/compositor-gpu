// The devtools' recording model (src/devtools/model.ts): frames by time,
// late frames and their hitches, costs by element and GPU label.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Model } from '../../src/devtools/model'
import type { FrameSample } from '../../src/profile/profiler'
import { toRecording } from '../../src/profile/recording'

const R = 1000 / 60
const frame = (t: number, over: Partial<FrameSample> = {}): FrameSample => ({
  id: Math.round(t),
  t,
  dt: R,
  continuous: true,
  requested: 0,
  wait: 0,
  read: 'none',
  cause: '',
  readElements: 0,
  uploads: {},
  batches: 1,
  draws: 1,
  groups: 0,
  reused: false,
  gpu: null,
  cpu: {
    total: 2,
    read: 1,
    hooks: 0,
    upload: 0,
    encode: 0.5,
    cull: 0,
    scene: 0,
    batches: 0,
    text: 0,
    other: 0.5
  },
  ...over
})

const model = (): Model => {
  const samples = [
    frame(1000 + R),
    frame(1000 + 2 * R, {
      why: {
        events: [{ kind: 'attributes', el: 1, detail: 'class', n: 2 }],
        more: 0,
        scopes: [1, 2],
        scopeCount: 2,
        alive: ['scroll', 'pass blur', 'layer dots (pointer)']
      },
      gpu: {
        frame: 2,
        spans: [
          { label: 'main', ms: 3, start: 0 },
          { label: 'fx:blur', ms: 1, start: 3 },
          { label: 'fx:blur#1', ms: 0.5, start: 4 }
        ],
        totalMs: 3,
        untimed: 0
      }
    }),
    frame(1000 + 2 * R + 60, { dt: 60 }),
    frame(1000 + 3 * R + 60)
  ]
  return new Model(
    toRecording(
      {
        frames: 4,
        durationMs: 0,
        refreshMs: R,
        dt: { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 },
        late: 0,
        dropped: 0,
        cpu: {} as never,
        gpu: null,
        reads: {} as never,
        hitches: [],
        gpuTiming: true,
        phases: [],
        marks: [],
        longFrames: [],
        samples,
        env: { dpr: 1, width: 1, height: 1, userAgent: '' },
        elements: { 1: 'div.a', 2: 'div.b' },
        filmstrip: [
          { at: 10, src: 'data:,a' },
          { at: 40, src: 'data:,b' }
        ],
        origin: 1000
      },
      'flight'
    )
  )
}

test('frames by time, late frames and their hitch', () => {
  const m = model()
  assert.deepEqual(m.late, [2])
  assert.equal(m.frameAt(2 * R), 1)
  assert.equal(m.frameAt(2 * R + 30), 2)
  assert.equal(m.frameAt(1e9), 3)
  const h = m.hitch(2)
  assert.equal(h.dt, 60)
  assert.ok(h.missed >= 2)
  assert.equal(m.hitch(2), h)
})

test('costs by element and GPU label', () => {
  const m = model()
  const els = m.elementCosts()
  assert.deepEqual(
    els.map((c) => [c.path, c.reads, c.readMs, c.events]),
    [
      ['div.a', 1, 0.5, 2],
      ['div.b', 1, 0.5, 0]
    ]
  )
  assert.deepEqual(m.gpuCosts()[0], {
    label: 'main',
    frames: 1,
    totalMs: 3,
    maxMs: 3
  })
  assert.deepEqual(m.effectCosts(), [
    { kind: 'pass', name: 'blur', frames: 1, gpuMs: 1.5, gpuFrames: 1 },
    { kind: 'layer', name: 'dots', frames: 1, gpuMs: 0, gpuFrames: 0 }
  ])
  assert.equal(m.aliveCosts()[0]?.[0], 'scroll')
  assert.equal(m.path(9), 'element 9')
})

test('filmstrip pictures around a time', () => {
  const m = model()
  assert.deepEqual(m.picturesAround(25), { before: 0, after: 1 })
  assert.deepEqual(m.picturesAround(5), { before: -1, after: 0 })
  assert.deepEqual(m.picturesAround(99), { before: 1, after: -1 })
})
