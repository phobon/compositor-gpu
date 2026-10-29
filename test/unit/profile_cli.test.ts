// The profiler CLI's pure parts (tools/profile/): budgets against a
// report, the baseline comparison, scenario steps.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type FrameSample,
  type ProfileReport,
  summarize
} from '../../src/profile/profiler'
import { checkBudget, formatBudget } from '../../tools/profile/budget'
import { compareReports, compareRuns } from '../../tools/profile/compare'
import { medianRun, runLine } from '../../tools/profile/runs'
import {
  describeStep,
  scrollScenario,
  validateSteps
} from '../../tools/profile/scenario'

const R = 1000 / 60
const frame = (t: number, over: Partial<FrameSample> = {}): FrameSample => ({
  id: Math.round(t),
  t,
  start: t + 0.1,
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
    total: 1,
    read: 0.2,
    hooks: 0,
    upload: 0,
    encode: 0.4,
    cull: 0,
    scene: 0,
    batches: 0,
    text: 0,
    other: 0.4
  },
  ...over
})

// 20 frames; one late after a 30 ms compositor read (marks: a at 0, b at 200 ms).
const report = (): ProfileReport => {
  const samples: FrameSample[] = []
  let t = 1000
  for (let i = 0; i < 20; i++) {
    t += R
    samples.push(frame(t))
  }
  const slow = samples[19] as FrameSample
  slow.cpu = { ...slow.cpu, total: 31, read: 30 }
  slow.read = 'full'
  t += 50
  samples.push(frame(t, { dt: 50 }))
  const s = summarize(samples, R, 1000)
  const phase = (from: number, to: number) =>
    summarize(
      samples.filter((x) => x.t - 1000 >= from && x.t - 1000 < to),
      R,
      1000
    )
  return {
    ...s,
    gpuTiming: false,
    phases: [
      { label: 'a', summary: phase(0, 200) },
      { label: 'b', summary: phase(200, Infinity) }
    ],
    marks: [
      { at: 0, label: 'a' },
      { at: 200, label: 'b' }
    ],
    longFrames: [],
    samples,
    env: {
      dpr: 1,
      width: 800,
      height: 600,
      userAgent: 'x',
      adapter: 'apple metal-3'
    },
    origin: 1000
  }
}

test('budgets: run and phases, compositor-caused drops', () => {
  const r = report()
  const rows = checkBudget(r, {
    droppedCompositor: 0,
    late: 1,
    cpuP95: 40,
    gpuP95: 1,
    phases: {
      a: { droppedCompositor: 0 },
      b: { droppedCompositor: 0 },
      c: { late: 0 }
    }
  })
  const by = (scope: string, name: string) =>
    rows.find((x) => x.scope === scope && x.name === name)
  assert.equal(by('run', 'droppedCompositor')?.ok, false)
  assert.ok((by('run', 'droppedCompositor')?.value ?? 0) >= 2)
  assert.equal(by('run', 'late')?.ok, true)
  assert.equal(by('run', 'cpuP95')?.ok, true)
  // No GPU timings: no row.
  assert.equal(by('run', 'gpuP95'), undefined)
  // The late frame is at ~383 ms: phase b.
  assert.equal(by('a', 'droppedCompositor')?.value, 0)
  assert.ok((by('b', 'droppedCompositor')?.value ?? 0) >= 2)
  // A phase the run lacks fails.
  assert.equal(by('c', 'late')?.ok, false)
  assert.match(formatBudget(rows), /OVER run droppedCompositor/)
  assert.match(formatBudget(rows), /no phase/)
})

test('baseline comparison flags another adapter', () => {
  const a = report()
  const b = { ...report(), env: { ...a.env, adapter: 'swiftshader' } }
  const lines = compareReports(a, b)
  assert.match(lines[0] ?? '', /adapters differ/)
  assert.ok(lines.some((l) => /^late frames\s+1\.00 →\s+1\.00/.test(l)))
})

test('scenario steps: validated, described, the default scroll', () => {
  assert.deepEqual(scrollScenario(8).map(describeStep), [
    'down',
    'scroll to bottom',
    'up',
    'scroll to top'
  ])
  assert.equal(validateSteps([{ click: '#x' }]).length, 1)
  assert.throws(() => validateSteps([{ jump: 1 }]), /step 1/)
  assert.throws(() => validateSteps({}), /must be an array/)
})

test('the comparison covers phases both runs have and GPU labels', async () => {
  const { compareReports: compare } = await import('../../src/profile/compare')
  const a = report()
  const c = compare(a, report())
  assert.deepEqual(c.warnings, [])
  assert.ok(c.rows.some((r) => r.scope === 'a' && r.metric === 'late frames'))
  assert.ok(c.rows.some((r) => r.scope === 'b'))
  assert.ok(c.rows.every((r) => r.scope !== 'gpu'))
})

const withDropped = (dropped: number): ProfileReport => {
  const r = report()
  return {
    ...r,
    dropped,
    phases: r.phases.map((p, i) => ({
      ...p,
      summary: { ...p.summary, dropped: i === 0 ? dropped : 0 }
    }))
  }
}

test('several runs: the median run, a line each', () => {
  const runs = [withDropped(126), withDropped(67), withDropped(80)]
  assert.equal(medianRun(runs), 2)
  assert.equal(medianRun([withDropped(10), withDropped(30)]), 0)
  assert.match(
    runLine(runs[1] as ProfileReport, 1),
    /^run 2: dropped 67 \(a 67\), late 1$/
  )
})

test('runs compare by median, with each run as the spread', async () => {
  const { compareRuns: rows } = await import('../../src/profile/compare')
  const now = [withDropped(70), withDropped(135), withDropped(78)]
  const base = [withDropped(36), withDropped(77)]
  const dropped = rows(now, base).rows.find(
    (r) => r.scope === 'run' && r.metric === 'dropped frames'
  )
  assert.equal(dropped?.now, 78)
  assert.equal(dropped?.base, 56.5)
  assert.deepEqual(dropped?.nowRuns, [70, 135, 78])
  const lines = compareRuns(now, base)
  assert.ok(
    lines.some((l) =>
      /^dropped frames\s+56\.50 →\s+78\.00\s+\+21\.50\s+\[36–77 → 70–135, within spread\]$/.test(
        l
      )
    )
  )
  const apart = compareRuns([withDropped(10), withDropped(12)], base)
  assert.ok(apart.some((l) => /^dropped frames.*\[36–77 → 10–12\]$/.test(l)))
  // One run a side: as before, no spread.
  assert.ok(
    compareReports(withDropped(5), withDropped(9)).some((l) =>
      /^dropped frames\s+9\.00 →\s+5\.00\s+-4\.00$/.test(l)
    )
  )
})
