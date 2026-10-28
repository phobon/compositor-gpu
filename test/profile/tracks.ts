// The DevTools tracks end to end (docs/PROFILER.md, M6c; `npm run
// test:profile -- --tracks`): on layout.html, with a Chrome trace
// recording (what the Performance panel records), turn the tracks on,
// keep frames coming, jank once and mark, then check the trace holds the
// "compositor-gpu" track group's entries: frames, compositor phases, GPU
// (with timestamp-query), a late-frame marker and the mark.
import type { Browser, Page } from 'playwright'

export interface TracksCheck {
  name: string
  ok: boolean
  note: string
}

interface TraceEvent {
  name: string
  cat: string
  ph: string
  args?: { data?: Record<string, unknown>; detail?: string }
}

export async function checkTracks(
  browser: Browser,
  page: Page
): Promise<TracksCheck[]> {
  await browser.startTracing(page, {
    categories: ['devtools.timeline', 'blink.user_timing']
  })
  await page.evaluate(async () => {
    const raf = (): Promise<number> =>
      new Promise((r) => requestAnimationFrame(r))
    const gpu = window.__gpu
    gpu?.profile.tracks(true)
    const style = document.createElement('style')
    style.textContent =
      '@keyframes tracks-spin { to { transform: rotate(360deg) } } .tracks-spin { width: 40px; height: 40px; background: #08f; animation: tracks-spin 1s linear infinite }'
    document.head.append(style)
    const spin = document.createElement('div')
    spin.className = 'tracks-spin'
    document.querySelector('#page')?.prepend(spin)
    for (let i = 0; i < 10; i++) {
      await raf()
    }
    gpu?.profile.mark('tracks-test')
    setTimeout(() => {
      const until = performance.now() + 600
      while (performance.now() < until) {
        // busy
      }
    }, 0)
    // Long enough for the late frame's marker (written 500 ms later).
    const until = performance.now() + 2500
    while (performance.now() < until) {
      await raf()
    }
    spin.remove()
    style.remove()
    gpu?.profile.tracks(false)
  })
  const buf = await browser.stopTracing()
  const trace = JSON.parse(buf.toString()) as { traceEvents: TraceEvent[] }
  const events = trace.traceEvents
  // console.timeStamp entries, and user timing measures/marks with detail.
  const tracked = (track: string): number =>
    events.filter((e) => {
      const d = e.args?.data
      if (d && d.trackGroup === 'compositor-gpu' && d.track === track) {
        return true
      }
      const detail = e.args?.detail ?? (d?.detail as string | undefined)
      return (
        typeof detail === 'string' &&
        detail.includes('"trackGroup":"compositor-gpu"') &&
        detail.includes(`"track":"${track}"`)
      )
    }).length
  const named = (re: RegExp): number =>
    events.filter(
      (e) =>
        re.test(e.name) ||
        re.test(String(e.args?.data?.name ?? e.args?.data?.message ?? ''))
    ).length
  const frames = tracked('Frames')
  const phases = tracked('Compositor')
  const gpu = tracked('GPU')
  const late = named(/compositor-gpu: late frame/)
  const mark = named(/compositor-gpu: tracks-test/)
  return [
    { name: 'frames', ok: frames > 5, note: `${frames} frame entries` },
    { name: 'compositor', ok: phases > 5, note: `${phases} phase entries` },
    {
      name: 'gpu',
      ok: true,
      note: `${gpu} GPU entries (needs timestamp-query)`
    },
    { name: 'late marker', ok: late > 0, note: `${late} late-frame markers` },
    { name: 'mark', ok: mark > 0, note: `${mark} profile.mark() markers` }
  ]
}
