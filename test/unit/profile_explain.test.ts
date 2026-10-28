// The profiler's recorder core (docs/PROFILER.md): hitch factors
// (src/profile/explain.ts), trace folding and element paths
// (src/profile/trace.ts), the recording format (src/profile/recording.ts)
// and summarize()'s use of them.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { causeOf, explain } from '../../src/profile/explain'
import {
  type FrameSample,
  type LongFrame,
  summarize
} from '../../src/profile/profiler'
import {
  decodeRecording,
  encodeRecording,
  toRecording
} from '../../src/profile/recording'
import { ElementRegistry, elPath, TraceBuffer } from '../../src/profile/trace'

const REFRESH = 1000 / 60

const frame = (
  t: number,
  over: Partial<FrameSample> & { cpu?: Partial<FrameSample['cpu']> } = {}
): FrameSample => ({
  id: t,
  t,
  start: t + 0.2,
  dt: REFRESH,
  continuous: true,
  requested: 0,
  wait: 0,
  read: 'none',
  cause: '',
  readElements: 0,
  uploads: {},
  batches: 4,
  draws: 20,
  groups: 0,
  reused: false,
  gpu: null,
  ...over,
  cpu: {
    total: 1,
    read: 0,
    hooks: 0,
    upload: 0,
    encode: 0.5,
    cull: 0,
    scene: 0,
    batches: 0,
    text: 0,
    other: 0.5,
    ...over.cpu
  }
})

test('a slow DOM read names its trigger and the elements read', () => {
  const before = frame(1000, {
    read: 'partial',
    readElements: 412,
    cpu: { total: 30, read: 28 },
    why: {
      events: [{ kind: 'attributes', el: 3, detail: 'class', n: 2 }],
      more: 0,
      scopes: [3, 4],
      scopeCount: 2,
      alive: []
    }
  })
  const late = frame(1050, { dt: 50 })
  const fs = explain({
    before,
    prev: before,
    late,
    from: 1000,
    to: 1050,
    refresh: REFRESH,
    origin: 0,
    longFrames: [],
    path: (i) => ['', '', '', 'div.stage', 'img.shot'][i]
  })
  assert.equal(fs[0]?.kind, 'read')
  assert.match(fs[0]?.text ?? '', /412 elements/)
  assert.match(fs[0]?.text ?? '', /attributes div\.stage\[class\] ×2/)
  assert.deepEqual(fs[0]?.els, [3, 4])
  assert.equal(causeOf(fs[0]?.kind), 'compositor cpu')
})

test('scripts in a long frame, the compositor own callback left out', () => {
  const prev = frame(1000)
  const late = frame(1060, { dt: 60 })
  const lf: LongFrame = {
    at: 1005,
    duration: 50,
    blocking: 0,
    layout: 6,
    render: 9,
    scripts: [
      {
        name: 'event-listener scroll onScroll (app.js)',
        ms: 30,
        at: 1006,
        source: 'https://x/app.js:120',
        forced: 4
      },
      // The compositor's frame callback (starts at prev.start).
      { name: 'FrameRequestCallback', ms: 3, at: 1000.2 }
    ]
  }
  const fs = explain({
    before: prev,
    prev,
    late,
    from: 1000,
    to: 1060,
    refresh: REFRESH,
    origin: 0,
    longFrames: [lf]
  })
  assert.deepEqual(
    fs.map((f) => f.kind),
    ['script', 'unattributed', 'layout']
  )
  assert.match(fs[0]?.text ?? '', /onScroll.*forced layout 4\.0 ms/)
  assert.equal(fs[0]?.source, 'https://x/app.js:120')
  // 50 - 6 layout - 33 scripts.
  assert.equal(fs[1]?.ms, 11)
})

test('nothing recorded: one unattributed factor for the overrun', () => {
  const fs = explain({
    before: frame(0),
    prev: frame(0),
    late: frame(50, { dt: 50 }),
    from: 0,
    to: 50,
    refresh: REFRESH,
    origin: 0,
    longFrames: []
  })
  assert.equal(fs.length, 1)
  assert.equal(fs[0]?.kind, 'unattributed')
  assert.ok(Math.abs((fs[0]?.ms ?? 0) - (50 - REFRESH)) < 1e-9)
})

test('summarize gives each hitch its factors and the old cause', () => {
  const samples = [0, 1, 2, 3].map((i) => frame(i * REFRESH))
  const slow = frame(4 * REFRESH, {
    gpu: {
      frame: 4,
      spans: [{ label: 'fx:blur', ms: 30, start: 0 }],
      totalMs: 30,
      untimed: 0
    }
  })
  samples.push(slow, frame(4 * REFRESH + 50, { dt: 50 }))
  const s = summarize(samples, REFRESH)
  assert.equal(s.hitches.length, 1)
  const h = s.hitches[0]
  assert.equal(h?.cause, 'gpu')
  assert.equal(h?.factors?.[0]?.kind, 'gpu')
  assert.match(h?.detail ?? '', /fx:blur 30\.0 ms/)
})

test('trace events fold back-to-back repeats and cap', () => {
  const reg = new ElementRegistry()
  const tb = new TraceBuffer(reg)
  for (let i = 0; i < 5; i++) {
    tb.note('scroll')
  }
  tb.note('font')
  for (let i = 0; i < 20; i++) {
    tb.note(`k${i}`)
  }
  const { events, more } = tb.take()
  assert.deepEqual(events[0], { kind: 'scroll', n: 5 })
  assert.deepEqual(events[1], { kind: 'font' })
  assert.equal(events.length, 12)
  assert.equal(more, 10)
  assert.deepEqual(tb.take(), { events: [], more: 0 })
})

test('element paths stop at an id, tell same-tag siblings apart', () => {
  type Fake = {
    tagName: string
    id: string
    className: string
    parentElement: Fake | null
    children: Fake[]
  }
  const mk = (tag: string, id = '', cls = ''): Fake => ({
    tagName: tag.toUpperCase(),
    id,
    className: cls,
    parentElement: null,
    children: []
  })
  const add = (p: Fake, c: Fake): Fake => {
    c.parentElement = p
    p.children.push(c)
    return c
  }
  const main = mk('main', 'app')
  const sec = add(main, mk('section', '', 'duo  showcase extra'))
  add(sec, mk('div'))
  const d2 = add(sec, mk('div'))
  const img = add(d2, mk('img', '', 'shot'))
  assert.equal(
    elPath(img as unknown as Element),
    'main#app > section.duo.showcase > div:nth-of-type(2) > img.shot'
  )
})

test('a recording round-trips, gzipped and plain', async () => {
  const s = summarize([frame(0), frame(REFRESH)], REFRESH)
  const rec = toRecording(
    {
      ...s,
      gpuTiming: false,
      phases: [],
      marks: [],
      longFrames: [],
      samples: [frame(0)],
      env: { dpr: 2, width: 800, height: 600, userAgent: 'test' },
      elements: { 3: 'div.stage' }
    },
    'flight',
    'scroll test'
  )
  const gz = await encodeRecording(rec)
  assert.equal(gz[0], 0x1f)
  const back = await decodeRecording(gz)
  assert.equal(back.kind, 'flight')
  assert.equal(back.title, 'scroll test')
  assert.equal(back.report.elements?.[3], 'div.stage')
  const plain = await decodeRecording(await encodeRecording(rec, false))
  assert.equal(plain.report.samples.length, 1)
  await assert.rejects(decodeRecording('{"format":"x"}'), /not a compositor/)
  await assert.rejects(
    decodeRecording(JSON.stringify({ ...rec, version: 99 })),
    /version 99/
  )
})
