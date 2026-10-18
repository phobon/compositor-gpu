// The /fx effects clock and the lifecycle passes, layers, materials and
// trails share (src/fx/clock.ts, src/fx/lifecycle.ts).
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type ClockOverride, EffectsClock } from '../../src/fx/clock'
import {
  anyEnabled,
  keepAlive,
  Lifecycle,
  type LifecycleOptions
} from '../../src/fx/lifecycle'

function clockWith(reducedOn = false, o: ClockOverride | null = null) {
  const reduced = { on: reducedOn }
  let override = o
  const clock = new EffectsClock(reduced, () => override)
  return {
    clock,
    reduced,
    set(next: ClockOverride | null) {
      override = next
    }
  }
}

describe('EffectsClock', () => {
  test('follows the frame time', () => {
    const { clock } = clockWith()
    clock.tick(1000)
    clock.tick(1500)
    assert.equal(clock.nowMs(), 1500)
    assert.equal(clock.time(), 1.5)
    assert.equal(clock.held(), false)
  })

  test('holds still under reduced motion after the first frame', () => {
    const { clock } = clockWith(true)
    clock.tick(1000)
    clock.tick(5000)
    assert.equal(clock.nowMs(), 1000)
    assert.equal(clock.held(), true)
  })

  test('a test time overrides it and is never held', () => {
    const { clock } = clockWith(true, { time: 7, elapsed: 2, dt: 0.01 })
    clock.tick(1000)
    assert.equal(clock.time(), 7)
    assert.equal(clock.held(), false)
    assert.equal(clock.elapsed(0), 2)
    assert.equal(clock.dtOverride(), 0.01)
  })

  test('elapsed from a start, zero on the starting frame', () => {
    const { clock } = clockWith()
    clock.tick(3000)
    assert.equal(clock.elapsed(1000), 2)
    assert.equal(clock.elapsed(null), 0)
    assert.equal(clock.dtOverride(), null)
  })
})

function life(over: Partial<LifecycleOptions> = {}) {
  const calls = { wakes: 0, toggled: [] as boolean[] }
  const l = new Lifecycle({
    enabled: true,
    continuous: false,
    timed: true,
    wake: () => {
      calls.wakes++
    },
    toggled: (on) => {
      calls.toggled.push(on)
    },
    ...over
  })
  return { l, calls }
}

describe('Lifecycle', () => {
  test('enabling restarts the clock, runs toggled, then wakes', () => {
    const { clock } = clockWith()
    const { l, calls } = life()
    clock.tick(1000)
    l.start(clock)
    assert.equal(l.enabledAt, 1000)
    l.setEnabled(false)
    l.setEnabled(true)
    assert.equal(l.enabledAt, null)
    assert.deepEqual(calls.toggled, [false, true])
    assert.equal(calls.wakes, 2)
  })

  test('setting the same value does nothing', () => {
    const { l, calls } = life()
    l.setEnabled(true)
    l.setContinuous(false)
    assert.equal(calls.wakes, 0)
    assert.deepEqual(calls.toggled, [])
    l.setContinuous(true)
    assert.equal(calls.wakes, 1)
  })

  test('param writes wake only while enabled', () => {
    const { l, calls } = life({ enabled: false })
    l.paramsChanged()
    assert.equal(calls.wakes, 0)
    l.enabled = true
    l.paramsChanged()
    assert.equal(calls.wakes, 1)
  })

  test('no wake from inside its own frame', () => {
    const { l, calls } = life()
    const out = l.inside(() => {
      l.paramsChanged()
      l.wake()
      return 5
    })
    assert.equal(out, 5)
    assert.equal(calls.wakes, 0)
    l.wake()
    assert.equal(calls.wakes, 1)
  })

  test('the frame guard lifts even when the frame throws', () => {
    const { l, calls } = life()
    assert.throws(() =>
      l.inside(() => {
        throw new Error('update hook')
      })
    )
    l.wake()
    assert.equal(calls.wakes, 1)
  })

  test('destroy runs once', () => {
    const { l } = life()
    assert.equal(l.destroy(), true)
    assert.equal(l.destroy(), false)
    assert.equal(l.destroyed, true)
  })

  test('the clock starts on the first frame and keeps that start', () => {
    const { clock } = clockWith()
    const { l } = life()
    clock.tick(1000)
    l.start(clock)
    clock.tick(2500)
    l.start(clock)
    assert.equal(l.elapsed(clock), 1.5)
  })
})

describe('keepAlive', () => {
  const still = () => false
  const moving = () => true

  test('a continuous effect keeps the loop running', () => {
    const { clock } = clockWith()
    const { l } = life({ continuous: true })
    assert.equal(keepAlive([l], clock, still), true)
    l.enabled = false
    assert.equal(keepAlive([l], clock, still), false)
  })

  test('a held clock stops timed effects; layers keep simulating', () => {
    const { clock } = clockWith(true)
    const timed = life({ continuous: true, timed: true }).l
    const layer = life({ continuous: true, timed: false }).l
    assert.equal(keepAlive([timed], clock, still), false)
    assert.equal(keepAlive([layer], clock, still), true)
  })

  test('something busy keeps it running, enabled or not', () => {
    const { clock } = clockWith()
    const { l } = life({ enabled: false, continuous: null, busy: () => true })
    assert.equal(keepAlive([l], clock, still), true)
  })

  test('an enabled effect keeps it running while the pointer moves', () => {
    const { clock } = clockWith()
    const { l } = life({ continuous: false })
    assert.equal(keepAlive([l], clock, moving), true)
    assert.equal(keepAlive([l], clock, still), false)
  })

  test('a kind with no continuous flag (trails) only counts when busy', () => {
    const { clock } = clockWith()
    const { l } = life({ continuous: null, busy: () => false })
    assert.equal(keepAlive([l], clock, moving), false)
    assert.equal(anyEnabled([l]), true)
  })
})
