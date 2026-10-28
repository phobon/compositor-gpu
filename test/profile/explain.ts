// The recorder core end to end (docs/PROFILER.md, `npm run test:profile
// -- --explain`): on layout.html with the flight recorder on, jank the page
// on purpose and check that save() explains it.
//
//   script   with frames coming (a CSS animation), a timer task named
//            `jankTask` (from a blob: script, so it has a source) busy for
//            600 ms, three times: a hitch whose factors name it (where the
//            browser reports long animation frames; 600 ms stands out from
//            SwiftShader's slow frames)
//   read     a class toggled on every card: the next frame's why names
//            the attribute change and the elements re-read
//
// Prints the hitches it found and fails (exit 1) when a check doesn't
// hold.
import type { Page } from 'playwright'
import type { ProfileReport } from '../../src/profile/profiler'

export interface ExplainCheck {
  name: string
  ok: boolean
  note: string
}

export async function checkExplain(page: Page): Promise<ExplainCheck[]> {
  const out: ExplainCheck[] = []
  const loaf = await page.evaluate(() =>
    PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')
  )
  await page.evaluate(() => {
    window.__gpu?.profile.flight({ seconds: 10 })
  })
  await page.waitForTimeout(500)

  // A spinner keeps frames coming (a CSS animation re-reads its scope
  // each frame), then a timer task busy for 600 ms, three times.
  await page.evaluate(async () => {
    const raf = (): Promise<number> =>
      new Promise((r) => requestAnimationFrame(r))
    const style = document.createElement('style')
    style.textContent =
      '@keyframes explain-spin { to { transform: rotate(360deg) } } .explain-spin { width: 40px; height: 40px; background: #08f; animation: explain-spin 1s linear infinite }'
    document.head.append(style)
    const spin = document.createElement('div')
    spin.className = 'explain-spin'
    document.querySelector('#page')?.prepend(spin)
    for (let i = 0; i < 20; i++) {
      await raf()
    }
    window.__gpu?.profile.mark('jank')
    // From a script with a URL, so the browser names the function.
    const code =
      'function jankTask() { const until = performance.now() + 600; while (performance.now() < until) {} } window.__jankTask = jankTask'
    const url = URL.createObjectURL(
      new Blob([code], { type: 'text/javascript' })
    )
    await new Promise((r) => {
      const s = document.createElement('script')
      s.src = url
      s.onload = r
      document.head.append(s)
    })
    const task = (window as unknown as { __jankTask: () => void }).__jankTask
    for (let k = 0; k < 3; k++) {
      setTimeout(task, 0)
      for (let i = 0; i < 6; i++) {
        await raf()
      }
    }
    spin.remove()
    style.remove()
    for (let i = 0; i < 6; i++) {
      await raf()
    }
  })
  // A class on every card.
  await page.evaluate(async () => {
    const raf = (): Promise<number> =>
      new Promise((r) => requestAnimationFrame(r))
    window.__gpu?.profile.mark('mutate')
    for (const el of document.querySelectorAll('.card')) {
      el.classList.toggle('explain-test')
    }
    for (let i = 0; i < 10; i++) {
      await raf()
    }
  })
  const report = (await page.evaluate(
    () => window.__gpu?.profile.save() ?? null
  )) as ProfileReport | null
  await page.evaluate(() => window.__gpu?.profile.flight(false))
  if (!report) {
    return [{ name: 'save', ok: false, note: 'save() returned null' }]
  }
  out.push({
    name: 'save',
    ok: report.samples.length > 0 && report.marks.length >= 2,
    note: `${report.samples.length} frames, marks ${report.marks.map((m) => m.label).join(', ')}, ${report.hitches.length} hitches`
  })
  for (const h of report.hitches.slice(0, 4)) {
    console.log(
      `[explain] hitch +${(h.at / 1000).toFixed(2)} s ${h.dt.toFixed(1)} ms (${h.cause})`
    )
    for (const f of h.factors ?? []) {
      console.log(
        `[explain]   ${f.kind.padEnd(12)} ${f.ms.toFixed(1).padStart(6)} ms  ${f.text}${f.source ? `  <${f.source}>` : ''}`
      )
    }
  }
  const scripted = report.hitches.some((h) =>
    (h.factors ?? []).some(
      (f) => f.kind === 'script' && /jankTask/.test(f.text)
    )
  )
  out.push({
    name: 'script',
    ok: scripted || !loaf,
    note: loaf
      ? scripted
        ? 'a hitch names jankTask'
        : 'no hitch names jankTask'
      : 'no long-animation-frame here: not checked'
  })
  const mutateAt = report.marks.find((m) => m.label === 'mutate')?.at ?? 0
  const origin = report.origin ?? 0
  const read = report.samples.find(
    (s) =>
      s.t - origin >= mutateAt &&
      (s.why?.events ?? []).some(
        (e) => e.kind === 'attributes' && e.detail === 'class'
      )
  )
  const paths = (read?.why?.scopes ?? [])
    .map((i) => report.elements?.[i])
    .filter(Boolean)
  out.push({
    name: 'read',
    ok: Boolean(read) && read?.read !== 'none' && paths.length > 0,
    note: read
      ? `${read.read} read of ${read.readElements} elements, ${read.why?.scopeCount} scopes (${paths.slice(0, 2).join(', ')})`
      : 'no frame after the class change names it'
  })
  return out
}
