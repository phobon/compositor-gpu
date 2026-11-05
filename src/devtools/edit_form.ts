import type { Match, ParamInput, TriggerConfig, TriggerOn } from '../fx/config'
import type { ParamDef } from '../fx/params'
import type { Ease } from '../fx/tween'
import { h } from './model'

// The Edit tab's controls (docs/EDITOR.md, E3): a row per param (slider
// and number, vector fields, colour and alpha) and a row per trigger.
// They report changes; edit_view.ts turns them into config updates.

const num = (v: number): string => String(Number(v.toFixed(4)))

const hex2 = (x: number): string =>
  Math.round(Math.min(1, Math.max(0, x)) * 255)
    .toString(16)
    .padStart(2, '0')

/** [r, g, b, a] (0..1) → '#rrggbb' and alpha. */
export function toHex(v: readonly number[]): { rgb: string; a: number } {
  return {
    rgb: `#${hex2(v[0] ?? 0)}${hex2(v[1] ?? 0)}${hex2(v[2] ?? 0)}`,
    a: v[3] ?? 1
  }
}

/** A slider range for a param without one. */
export function rangeOf(def: ParamDef, v: number): [number, number] {
  if (def.min !== undefined && def.max !== undefined) {
    return [def.min, def.max]
  }
  const d = typeof def.default === 'number' ? def.default : 0
  const m = Math.max(1, Math.abs(d) * 4, Math.abs(v) * 2)
  return [def.min ?? (d < 0 || v < 0 ? -m : 0), def.max ?? m]
}

export interface ParamRow {
  readonly row: HTMLElement
  /** Show the effect's live value next to the control. */
  live(v: unknown): void
}

/**
 * One param: `value` is the config's (undefined: unset), `shown` what
 * the control starts at (config value or the effect's default as a
 * vector). `change(v, done)`: `done` false while dragging.
 */
export function paramRow(
  key: string,
  def: ParamDef,
  value: ParamInput | undefined,
  shown: readonly number[],
  change: (v: ParamInput | undefined, done: boolean) => void
): ParamRow {
  const liveEl = h('span', { class: 'livev dim' })
  const reset = h('button', {
    class: 'nav',
    type: 'button',
    text: '↺',
    title: 'Back to the effect’s default',
    hidden: value === undefined
  })
  reset.addEventListener('click', () => change(undefined, true))
  const ctl = h('span', { class: 'ctl' })
  if (def.count !== undefined) {
    ctl.append(h('span', { class: 'dim', text: `${def.count} × vec4` }))
  } else if (def.type === 'f32') {
    const v = shown[0] ?? 0
    const [min, max] = rangeOf(def, v)
    const range = h('input', {
      type: 'range',
      min,
      max,
      step: (max - min) / 1000,
      value: v
    })
    const box = h('input', { type: 'number', step: 'any', value: num(v) })
    range.addEventListener('input', () => {
      box.value = num(Number(range.value))
      change(Number(range.value), false)
    })
    range.addEventListener('change', () => change(Number(range.value), true))
    box.addEventListener('change', () => {
      const n = Number(box.value)
      if (Number.isFinite(n)) {
        range.value = String(n)
        change(n, true)
      }
    })
    ctl.append(range, box)
  } else if (def.type === 'color') {
    const { rgb, a } = toHex(shown)
    const pick = h('input', { type: 'color', value: rgb })
    const alpha = h('input', {
      type: 'number',
      min: 0,
      max: 1,
      step: 0.05,
      value: num(a),
      title: 'alpha'
    })
    const emit = (done: boolean): void => {
      const al = Math.min(1, Math.max(0, Number(alpha.value) || 0))
      change(al >= 1 ? pick.value : `${pick.value}${hex2(al)}`, done)
    }
    pick.addEventListener('input', () => emit(false))
    pick.addEventListener('change', () => emit(true))
    alpha.addEventListener('change', () => emit(true))
    ctl.append(pick, alpha)
  } else {
    const n = { vec2: 2, vec3: 3, vec4: 4 }[def.type]
    const boxes = Array.from({ length: n }, (_, i) =>
      h('input', { type: 'number', step: 'any', value: num(shown[i] ?? 0) })
    )
    for (const b of boxes) {
      b.addEventListener('change', () =>
        change(
          boxes.map((x) => Number(x.value) || 0),
          true
        )
      )
    }
    ctl.append(...boxes)
  }
  const row = h(
    'div',
    { class: `prow${value === undefined ? '' : ' set'}` },
    h('span', { class: 'pk', text: key }),
    ctl,
    reset,
    liveEl
  )
  return {
    row,
    live(v) {
      const s =
        typeof v === 'number'
          ? num(v)
          : Array.isArray(v) || ArrayBuffer.isView(v)
            ? Array.from(v as ArrayLike<number>, num).join(', ')
            : ''
      if (liveEl.textContent !== s) {
        liveEl.textContent = s
      }
    }
  }
}

const ONS: TriggerOn[] = [
  'load',
  'enter',
  'exit',
  'pointerenter',
  'pointerleave',
  'pointerdown',
  'pointerup',
  'click'
]

export const EASES: Record<string, [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1],
  linear: [0, 0, 1, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1]
}

/** The ease select's value for `e`: a name, 'spring' or 'custom'. */
export function easeName(e: Ease | undefined): string {
  if (!e) {
    return 'ease'
  }
  if ('spring' in e) {
    return 'spring'
  }
  for (const [k, v] of Object.entries(EASES)) {
    if (v.every((x, i) => x === e[i])) {
      return k
    }
  }
  return 'custom'
}

/** A target field's text as a Match: a bare name is a data-fx name. */
export function parseTarget(s: string): Match | undefined {
  const t = s.trim()
  if (!t) {
    return undefined
  }
  return /^[\w-]+$/.test(t) ? { fx: t } : { selector: t }
}

const targetText = (m: Match | undefined): string =>
  m ? ('fx' in m ? m.fx : m.selector) : ''

type Action = 'to' | 'rest' | 'play' | 'none'

const actionOf = (t: TriggerConfig): Action =>
  t.play ? 'play' : t.to === 'rest' ? 'rest' : t.to ? 'to' : 'none'

const select = (
  options: readonly string[],
  value: string,
  label: string
): HTMLSelectElement =>
  h(
    'select',
    { 'aria-label': label, title: label },
    ...options.map((o) =>
      h('option', { value: o, text: o, selected: o === value })
    )
  )

const field = (label: string, el: HTMLElement): HTMLElement =>
  h('label', { class: 'tf' }, h('span', { class: 'dim', text: label }), el)

/** One trigger's fields; `change` gets the edited trigger. */
export function triggerRow(
  t: TriggerConfig,
  change: (t: TriggerConfig) => void,
  fire: () => void,
  remove: () => void
): HTMLElement {
  const on = select(ONS, t.on, 'event')
  const action = select(['to', 'rest', 'play', 'none'], actionOf(t), 'action')
  const to = h('input', {
    type: 'text',
    class: 'json',
    placeholder: '{"progress": 1}',
    value: t.to && t.to !== 'rest' ? JSON.stringify(t.to) : ''
  })
  const play = select(
    ['forward', 'reverse', 'toggle'],
    t.play ?? 'forward',
    'play'
  )
  const en = select(
    ['—', 'enable', 'disable'],
    t.enabled === undefined ? '—' : t.enabled ? 'enable' : 'disable',
    'enabled'
  )
  const ease = select(
    [
      ...Object.keys(EASES),
      'spring',
      ...(easeName(t.ease) === 'custom' ? ['custom'] : [])
    ],
    easeName(t.ease),
    'ease'
  )
  const spring = t.ease && 'spring' in t.ease ? t.ease.spring : {}
  const dur = h('input', {
    type: 'number',
    step: 0.05,
    min: 0,
    value: num(t.duration ?? 0.4)
  })
  const delay = h('input', {
    type: 'number',
    step: 0.05,
    min: 0,
    value: num(t.delay ?? 0)
  })
  const vd = h('input', {
    type: 'number',
    step: 0.05,
    min: 0.01,
    value: num(spring.visualDuration ?? 0.3)
  })
  const bounce = h('input', {
    type: 'number',
    step: 0.05,
    min: 0,
    max: 1,
    value: num(spring.bounce ?? 0)
  })
  const target = h('input', {
    type: 'text',
    placeholder: 'data-fx name or selector',
    value: targetText(t.target)
  })
  const once = h('input', { type: 'checkbox', checked: !!t.once })

  const fields = {
    to: field('to', to),
    play: field('play', play),
    dur: field('duration', dur),
    vd: field('settle', vd),
    bounce: field('bounce', bounce)
  }
  const sync = (): void => {
    const a = action.value as Action
    fields.to.hidden = a !== 'to'
    fields.play.hidden = a !== 'play'
    const sp = ease.value === 'spring'
    fields.dur.hidden = sp
    fields.vd.hidden = !sp
    fields.bounce.hidden = !sp
  }
  const build = (): TriggerConfig | null => {
    const a = action.value as Action
    const out: TriggerConfig = { on: on.value as TriggerOn }
    const tg = parseTarget(target.value)
    if (tg) {
      out.target = tg
    }
    if (a === 'to') {
      try {
        const v = JSON.parse(to.value || '{}') as unknown
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          throw new Error('not an object')
        }
        out.to = v as Record<string, ParamInput>
        to.classList.remove('bad')
      } catch {
        to.classList.add('bad')
        return null
      }
    } else if (a === 'rest') {
      out.to = 'rest'
    } else if (a === 'play') {
      out.play = play.value as 'forward' | 'reverse' | 'toggle'
    }
    if (en.value !== '—') {
      out.enabled = en.value === 'enable'
    }
    if (ease.value === 'spring') {
      out.ease = {
        spring: {
          visualDuration: Number(vd.value) || 0.3,
          bounce: Number(bounce.value) || 0
        }
      }
    } else {
      out.duration = Math.max(0, Number(dur.value) || 0)
      if (ease.value === 'custom' && t.ease) {
        out.ease = t.ease
      } else if (ease.value !== 'ease') {
        out.ease = EASES[ease.value]
      }
    }
    const d = Number(delay.value) || 0
    if (d > 0) {
      out.delay = d
    }
    if (once.checked) {
      out.once = true
    }
    if (t.threshold !== undefined) {
      out.threshold = t.threshold
    }
    return out
  }
  const emit = (): void => {
    sync()
    const next = build()
    if (next) {
      change(next)
    }
  }
  for (const el of [
    on,
    action,
    play,
    en,
    ease,
    dur,
    delay,
    vd,
    bounce,
    to,
    target,
    once
  ]) {
    el.addEventListener('change', emit)
  }
  sync()
  const fireBtn = h('button', {
    class: 'btn',
    type: 'button',
    text: 'Fire',
    title: 'Run this trigger from the rest values'
  })
  fireBtn.addEventListener('click', fire)
  const del = h('button', {
    class: 'nav',
    type: 'button',
    text: '✕',
    title: 'Remove this trigger'
  })
  del.addEventListener('click', remove)
  return h(
    'div',
    { class: 'trow' },
    on,
    action,
    fields.to,
    fields.play,
    field('enabled', en),
    field('ease', ease),
    fields.dur,
    fields.vd,
    fields.bounce,
    field('delay', delay),
    field('target', target),
    field('once', once),
    fireBtn,
    del
  )
}
