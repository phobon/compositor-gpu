// Scenarios for `npm run profile` (tools/profile.ts; docs/PROFILER.md,
// M6d): what to do on the page while recording. A scenario file (JSON):
//
//   {
//     "name": "duo",
//     "url": "http://localhost:8000/duo?gpu=1",
//     "viewport": [1280, 900],
//     "dpr": 2,
//     "budget": { "droppedCompositor": 0 },
//     "steps": [
//       { "wait": 1000 },
//       { "waitFor": "#showcase" },
//       { "mark": "scroll" },
//       { "scroll": "bottom", "speed": 12 },
//       { "scroll": "#showcase" },
//       { "scrollBy": -600, "speed": 8 },
//       { "hover": ".card" },
//       { "click": "button[role=tab]:nth-of-type(2)" },
//       { "press": "ArrowRight" },
//       { "eval": "document.body.classList.add('x')" }
//     ]
//   }
//
// Scrolls run in the page, `speed` CSS px per frame (default 12), to the
// top, the bottom, a y or an element; hover, click and press go through
// the browser's real input. Phases: with no `mark` step, every step but
// `wait` marks the recording with what it does (so the report's phases
// follow the scenario); with any, only the marks do (a phase runs from
// one mark to the next).

import type { Page } from 'playwright'
import type { Budget } from './budget'

export type Step =
  | { wait: number }
  | { waitFor: string; timeout?: number }
  | { mark: string }
  | { scroll: 'top' | 'bottom' | number | string; speed?: number }
  | { scrollBy: number; speed?: number }
  | { hover: string }
  | { click: string }
  | { press: string }
  | { eval: string }

export interface Scenario {
  name?: string
  url?: string
  viewport?: [number, number]
  dpr?: number
  budget?: Budget
  steps: Step[]
}

/** The default when no steps are given: down to the bottom and back. */
export function scrollScenario(speed = 12): Step[] {
  return [
    { mark: 'down' },
    { scroll: 'bottom', speed },
    { mark: 'up' },
    { scroll: 'top', speed }
  ]
}

/** A step as a label (its mark). */
export function describeStep(s: Step): string {
  if ('wait' in s) {
    return `wait ${s.wait} ms`
  }
  if ('waitFor' in s) {
    return `wait for ${s.waitFor}`
  }
  if ('mark' in s) {
    return s.mark
  }
  if ('scroll' in s) {
    return `scroll to ${s.scroll}`
  }
  if ('scrollBy' in s) {
    return `scroll by ${s.scrollBy}`
  }
  if ('hover' in s) {
    return `hover ${s.hover}`
  }
  if ('click' in s) {
    return `click ${s.click}`
  }
  if ('press' in s) {
    return `press ${s.press}`
  }
  return 'eval'
}

/** Check a parsed scenario's steps; throws naming the bad one. */
export function validateSteps(steps: unknown): Step[] {
  if (!Array.isArray(steps)) {
    throw new Error('scenario: "steps" must be an array')
  }
  const known = [
    'wait',
    'waitFor',
    'mark',
    'scroll',
    'scrollBy',
    'hover',
    'click',
    'press',
    'eval'
  ]
  steps.forEach((s, i) => {
    if (
      !s ||
      typeof s !== 'object' ||
      !Object.keys(s).some((k) => known.includes(k))
    ) {
      throw new Error(
        `scenario: step ${i + 1} (${JSON.stringify(s)}) is none of ${known.join(', ')}`
      )
    }
  })
  return steps as Step[]
}

/** Run `steps` on `page`, marking the recording through `global`
 * (the page's compositor, e.g. `__gpu`). */
export async function runSteps(
  page: Page,
  steps: readonly Step[],
  global: string,
  log: (s: string) => void
): Promise<void> {
  const mark = (label: string): Promise<void> =>
    page.evaluate(
      ([g, l]) => {
        const c = (window as unknown as Record<string, unknown>)[g] as
          | { profile: { mark(l: string): void } }
          | undefined
        c?.profile.mark(l)
      },
      [global, label] as const
    )
  const auto = !steps.some((s) => 'mark' in s)
  for (const s of steps) {
    const label = describeStep(s)
    log(label)
    if ('wait' in s) {
      await page.waitForTimeout(s.wait)
      continue
    }
    if ('mark' in s) {
      await mark(s.mark)
      continue
    }
    if (auto) {
      await mark(label)
    }
    if ('waitFor' in s) {
      await page.waitForSelector(s.waitFor, { timeout: s.timeout ?? 30_000 })
    } else if ('scroll' in s || 'scrollBy' in s) {
      await page.evaluate(
        async ({ to, by, speed }) => {
          const raf = (): Promise<number> =>
            new Promise((r) => requestAnimationFrame(r))
          const max = (): number =>
            document.documentElement.scrollHeight - window.innerHeight
          let target: number
          if (by !== null) {
            target = window.scrollY + by
          } else if (to === 'top') {
            target = 0
          } else if (to === 'bottom') {
            target = max()
          } else if (typeof to === 'number') {
            target = to
          } else {
            const el = document.querySelector(String(to))
            if (!el) {
              throw new Error(`scroll: no element matches ${to}`)
            }
            const r = el.getBoundingClientRect()
            target =
              window.scrollY + r.top - (window.innerHeight - r.height) / 2
          }
          target = Math.max(0, Math.min(target, max()))
          // Until there, or stuck (the page stopped growing or a scroll
          // snap holds it) for a few frames.
          let stuck = 0
          while (Math.abs(window.scrollY - target) > 1 && stuck < 10) {
            const before = window.scrollY
            const d = target - window.scrollY
            window.scrollBy(0, Math.sign(d) * Math.min(Math.abs(d), speed))
            await raf()
            stuck = window.scrollY === before ? stuck + 1 : 0
            if (to === 'bottom') {
              target = max()
            }
          }
          await raf()
        },
        {
          to: 'scroll' in s ? s.scroll : null,
          by: 'scrollBy' in s ? s.scrollBy : null,
          speed: s.speed ?? 12
        }
      )
    } else if ('hover' in s) {
      await page.hover(s.hover)
    } else if ('click' in s) {
      await page.click(s.click)
    } else if ('press' in s) {
      await page.keyboard.press(s.press)
    } else if ('eval' in s) {
      await page.evaluate(s.eval)
    }
  }
}
