// Fill planner: replays the traces recorded from the renderer before the
// planner (fill_trace.ts) and checks scenarios through its interface.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  type DrawPlan,
  type FillInput,
  type FillPlan,
  FillPlanner
} from '../../src/gpu/fill_planner'
import type { FillTraceFrame } from './fill_trace'

const here = dirname(fileURLToPath(import.meta.url))
const traceDir = resolve(here, 'traces')

/** The trace's `changed` as a content key: changed frames have no key, the
 * rest match what the last drawn frame committed. */
function traceInput(f: FillTraceFrame): FillInput {
  return {
    now: f.now,
    scrollY: f.scrollY,
    height: f.height,
    canvasX: f.canvasX,
    canvasY: f.canvasY,
    devW: f.devW,
    devH: f.devH,
    sx: f.canvasWidth > 0 ? f.devW / f.canvasWidth : f.dpr,
    sy: f.canvasHeight > 0 ? f.devH / f.canvasHeight : f.dpr,
    canvasFill: f.canvasFill,
    skipUnchanged: f.skipUnchanged,
    reanchorStrips: f.reanchorStrips,
    chain: f.chain,
    backdrop: f.backdrops > 0,
    content: { now: f.changed ? null : 'same', commit: 'same' },
    layers: { rows: f.layers.rows, key: f.layers.key, live: f.layers.live },
    fixed: () => f.fixed
  }
}

/** What the old renderer recorded for a draw, from a plan. */
function decisions(p: DrawPlan): Partial<FillTraceFrame> {
  const out: Partial<FillTraceFrame> = {
    mainLoad: p.load,
    band: p.band,
    strip: p.strip,
    extra: p.extra,
    bandIsStrip: p.cull === 'strip',
    trimmed: p.cull === 'rows',
    bandY: p.bandY,
    stripFrom: p.stripFrom,
    fillRows: p.fillRows
  }
  if (p.keep) {
    out.stale = p.reset ? 'all' : p.fresh
  }
  return out
}

describe('replays the recorded traces', () => {
  const files = readdirSync(traceDir).filter((f) => f.endsWith('.json'))
  test('traces exist', () => {
    assert.ok(files.length > 0)
  })
  for (const file of files) {
    test(file, () => {
      const frames = JSON.parse(
        readFileSync(resolve(traceDir, file), 'utf8')
      ) as FillTraceFrame[]
      const planner = new FillPlanner()
      frames.forEach((f, n) => {
        const at = `${file} frame ${n}`
        const input = traceInput(f)
        if (f.kind === 'reuse') {
          planner.reuse(input)
        } else {
          const plan = planner.plan(input)
          assert.equal(plan.kind, f.kind, `${at}: kind`)
          if (plan.kind === 'draw') {
            const want: Partial<FillTraceFrame> = {
              mainLoad: f.mainLoad,
              band: f.band,
              strip: f.strip,
              extra: f.extra,
              bandIsStrip: f.bandIsStrip,
              trimmed: f.trimmed,
              bandY: f.bandY,
              stripFrom: f.stripFrom,
              fillRows: f.fillRows
            }
            if (f.stale !== undefined) {
              want.stale = f.stale
            }
            assert.deepEqual(decisions(plan), want, `${at}: decisions`)
          }
        }
        assert.equal(planner.lastStep, f.lastStep, `${at}: lastStep`)
        assert.deepEqual(
          planner.state(),
          {
            valid: f.valid,
            pending: f.pending,
            fixedScrollY: f.fixedScrollY,
            layerKey: f.layerKey
          },
          `${at}: state`
        )
      })
    })
  }
})

// Scenarios: a 1000 x 3000 device px canvas at dpr 1, a 900 px viewport.

let clock = 0

function frame(over: Partial<FillInput> = {}): FillInput {
  clock += 1000
  return {
    now: clock,
    scrollY: 1000,
    height: 900,
    canvasX: 0,
    canvasY: 0,
    devW: 1000,
    devH: 3000,
    sx: 1,
    sy: 1,
    canvasFill: 'band',
    skipUnchanged: true,
    reanchorStrips: true,
    chain: false,
    backdrop: false,
    content: { now: 'a', commit: 'a' },
    layers: { rows: [], key: '', live: false },
    fixed: () => [],
    ...over
  }
}

function draw(p: FillPlan): DrawPlan {
  assert.equal(p.kind, 'draw')
  return p as DrawPlan
}

describe('scenarios', () => {
  test('the first frame draws the whole canvas, a still one skips', () => {
    const planner = new FillPlanner()
    const first = draw(planner.plan(frame()))
    assert.equal(first.reset, true)
    assert.equal(first.band, null)
    assert.equal(first.fillRows, 3000)
    assert.deepEqual(planner.state().valid, [[0, 3000]])
    assert.equal(planner.plan(frame()).kind, 'skip')
  })

  test('the band is the viewport plus 128 px, then twice the scroll step', () => {
    const planner = new FillPlanner()
    planner.plan(frame({ content: { now: null, commit: 'a' } }))
    const p = draw(planner.plan(frame({ content: { now: null, commit: 'a' } })))
    assert.deepEqual(p.band, [0, 872, 1000, 1156])
    assert.deepEqual(p.bandY, [872, 2028])
    // A 300 px step pads by 600 px.
    clock -= 900
    const q = draw(
      planner.plan(
        frame({ scrollY: 1300, content: { now: null, commit: 'a' } })
      )
    )
    assert.deepEqual(q.band, [0, 700, 1000, 2100])
  })

  test('a content change redraws the band; unchanged rows are not', () => {
    const planner = new FillPlanner()
    planner.plan(frame())
    const p = draw(planner.plan(frame({ content: { now: 'b', commit: 'b' } })))
    assert.deepEqual(p.band, [0, 872, 1000, 1156])
    assert.deepEqual(planner.state().valid, [[872, 2028]])
    assert.equal(
      planner.plan(frame({ content: { now: 'b', commit: 'b' } })).kind,
      'skip'
    )
  })

  test('content with no key never matches', () => {
    const planner = new FillPlanner()
    planner.plan(frame())
    // An extra layer is active: no key now, and none to commit.
    draw(planner.plan(frame({ content: { now: null, commit: null } })))
    // It stopped: its pixels are still in the kept rows.
    const p = draw(planner.plan(frame({ content: { now: 'a', commit: 'a' } })))
    assert.equal(p.cull, 'canvas')
    assert.equal(planner.plan(frame()).kind, 'skip')
  })

  test('a re-anchor shifts the kept pixels and fills the new rows in strips', () => {
    const planner = new FillPlanner()
    planner.plan(frame({ scrollY: 2000, canvasY: 0 }))
    // The canvas re-anchors 1000 px down: the kept rows move up.
    const p = draw(planner.plan(frame({ scrollY: 2000, canvasY: 1000 })))
    assert.equal(p.shift, -1000)
    assert.deepEqual(p.fresh, [2000, 3000])
    assert.deepEqual(p.cleared, [2000, 3000])
    assert.equal(p.load, 'load')
    // The band reaches 28 rows into the new ones; the first strip (96
    // rows, nearest the band) touches it, so they draw as one, trimmed to
    // the rows not already valid.
    assert.equal(p.strip, null)
    assert.equal(p.cull, 'rows')
    assert.deepEqual(p.band, [0, 2000, 1000, 124])
    assert.equal(planner.pendingRowCount, 3000 - 2124)
    // Strips drain the pending rows on still frames, then it skips.
    let n = 0
    while (planner.pendingRowCount > 0 && n++ < 100) {
      const q = planner.plan(frame({ scrollY: 2000, canvasY: 1000 }))
      assert.equal(q.kind, 'draw')
    }
    assert.equal(planner.pendingRowCount, 0)
    assert.equal(
      planner.plan(frame({ scrollY: 2000, canvasY: 1000 })).kind,
      'skip'
    )
  })

  test('without strips, or with a backdrop, the new rows draw with the band', () => {
    for (const over of [{ reanchorStrips: false }, { backdrop: true }]) {
      const planner = new FillPlanner()
      planner.plan(frame({ scrollY: 2000, ...over }))
      const p = draw(
        planner.plan(frame({ scrollY: 2000, canvasY: 1000, ...over }))
      )
      assert.equal(p.strip, null)
      assert.equal(p.bandY, null)
      assert.equal(planner.pendingRowCount, 0)
      assert.ok(p.band && p.band[1] + p.band[3] === 3000)
    }
  })

  test('a shift that is not whole device rows redraws everything', () => {
    const planner = new FillPlanner()
    planner.plan(frame({ sy: 2, devH: 6000 }))
    const p = draw(planner.plan(frame({ sy: 2, devH: 6000, canvasY: 100.25 })))
    assert.equal(p.reset, true)
    assert.equal(p.band, null)
  })

  test('fixed content that moved against the canvas redraws its rows', () => {
    const planner = new FillPlanner()
    const fixed = () => [[0, 64]] as [number, number][]
    planner.plan(frame({ fixed }))
    const p = draw(planner.plan(frame({ scrollY: 1040, fixed })))
    // Rows at the old scroll and the new, merged (closer than 64 px).
    assert.equal(p.cull, 'rows')
    assert.deepEqual(p.band, [0, 1000, 1000, 104])
    assert.deepEqual(p.extra, [])
  })

  test('a layer transform redraws where its group was and is', () => {
    const planner = new FillPlanner()
    const at = (y: number) => ({
      rows: [[y, y + 100]] as [number, number][],
      key: `1:${y}`,
      live: false
    })
    planner.plan(frame({ layers: at(1200) }))
    const p = draw(planner.plan(frame({ layers: at(1500) })))
    assert.equal(p.cull, 'rows')
    assert.deepEqual(p.band, [0, 1200, 1000, 100])
    assert.deepEqual(p.extra, [[0, 1500, 1000, 100]])
    assert.equal(p.fillRows, 200)
    assert.equal(planner.plan(frame({ layers: at(1500) })).kind, 'skip')
  })

  test('a frame after the post chain is never skipped', () => {
    const planner = new FillPlanner()
    planner.plan(frame())
    planner.plan(frame({ chain: true }))
    assert.equal(planner.plan(frame()).kind, 'draw')
    assert.equal(planner.plan(frame()).kind, 'skip')
  })

  test("'full' draws everything and drops the kept rows", () => {
    const planner = new FillPlanner()
    planner.plan(frame())
    const p = draw(planner.plan(frame({ canvasFill: 'full' })))
    assert.equal(p.keep, false)
    assert.equal(p.band, null)
    assert.equal(p.fillRows, 3000)
    assert.deepEqual(planner.state().valid, [])
  })
})
