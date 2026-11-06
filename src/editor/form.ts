import type { Match, ParamInput, TriggerConfig, TriggerOn } from '../fx/config'
import type { ParamDef } from '../fx/params'
import type { Ease } from '../fx/tween'
import { h } from '../util/h'
import { icon } from './icons'

// The editor's controls (docs/EDITOR.md, E3): a row per param (slider
// and number, vector fields, colour and alpha) and a row per trigger.
// They report changes; the editor turns them into config updates.

const num = (v: number): string => String(Number(v.toFixed(4)))

const hex2 = (x: number): string =>
  Math.round(Math.min(1, Math.max(0, x)) * 255)
    .toString(16)
    .padStart(2, '0')

/** '#rgb[a]' / '#rrggbb[aa]' → [r, g, b, a] (0..1), or null. */
function hexVec(hex: string): number[] | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(hex.trim())
  const x = m?.[1]
  if (!x || ![3, 4, 6, 8].includes(x.length)) {
    return null
  }
  const short = x.length <= 4
  const out: number[] = []
  for (let i = 0; i < (short ? x.length : x.length / 2); i++) {
    const p = short ? (x[i] ?? '0').repeat(2) : x.slice(i * 2, i * 2 + 2)
    out.push(Number.parseInt(p, 16) / 255)
  }
  return out.length === 3 ? [...out, 1] : out
}

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
  /** Show the effect's live value under the control. */
  live(v: unknown): void
}

const AXES = ['X', 'Y', 'Z', 'W']

/** A number field with a short prefix inside it (`X`, `α`). */
const prefixed = (prefix: string, input: HTMLInputElement): HTMLElement =>
  h('span', { class: 'ig' }, h('span', { class: 'pre', text: prefix }), input)

/** Fill a range input's track up to its value (`--p`). */
const fill = (r: HTMLInputElement): void => {
  const min = Number(r.min)
  const max = Number(r.max)
  const p = max > min ? ((Number(r.value) - min) / (max - min)) * 100 : 0
  r.style.setProperty('--p', `${Math.min(100, Math.max(0, p))}%`)
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
  onChange: (v: ParamInput | undefined, done: boolean) => void
): ParamRow {
  // What the control shows, to show the live value only when it differs
  // (a trigger moving it).
  let cur: number[] | null = [...shown]
  const change = (v: ParamInput | undefined, done: boolean): void => {
    cur =
      v === undefined
        ? null
        : typeof v === 'number'
          ? [v]
          : typeof v === 'string'
            ? hexVec(v)
            : [...v]
    row.classList.toggle('set', v !== undefined)
    reset.hidden = v === undefined
    onChange(v, done)
  }
  const liveEl = h('span', { class: 'live' })
  const reset = h(
    'button',
    {
      class: 'btn ghost icon xs',
      type: 'button',
      title: 'Back to the effect’s default',
      'aria-label': `Reset ${key}`,
      hidden: value === undefined
    },
    icon('reset', 12)
  )
  reset.addEventListener('click', () => change(undefined, true))
  const ctl = h('div', { class: 'fc' })
  if (def.count !== undefined) {
    ctl.append(h('span', { class: 'muted', text: `${def.count} × vec4` }))
  } else if (def.type === 'f32') {
    const v = shown[0] ?? 0
    const [min, max] = rangeOf(def, v)
    const range = h('input', {
      type: 'range',
      class: 'slider',
      min,
      max,
      step: (max - min) / 1000,
      value: v,
      'aria-label': key
    })
    const box = h('input', {
      type: 'number',
      class: 'input num',
      step: 'any',
      value: num(v),
      'aria-label': `${key} value`
    })
    fill(range)
    range.addEventListener('input', () => {
      box.value = num(Number(range.value))
      fill(range)
      change(Number(range.value), false)
    })
    range.addEventListener('change', () => change(Number(range.value), true))
    box.addEventListener('change', () => {
      const n = Number(box.value)
      if (Number.isFinite(n)) {
        range.value = String(n)
        fill(range)
        change(n, true)
      }
    })
    ctl.append(range, box)
  } else if (def.type === 'color') {
    const { rgb, a } = toHex(shown)
    const pick = h('input', {
      type: 'color',
      class: 'swatch',
      value: rgb,
      'aria-label': key
    })
    const hex = h('input', {
      type: 'text',
      class: 'input mono hex',
      value: rgb,
      spellcheck: 'false',
      'aria-label': `${key} hex`
    })
    const alpha = h('input', {
      type: 'number',
      class: 'input num',
      min: 0,
      max: 1,
      step: 0.05,
      value: num(a),
      'aria-label': `${key} alpha`
    })
    const emit = (done: boolean): void => {
      const al = Math.min(1, Math.max(0, Number(alpha.value) || 0))
      change(al >= 1 ? pick.value : `${pick.value}${hex2(al)}`, done)
    }
    pick.addEventListener('input', () => {
      hex.value = pick.value
      emit(false)
    })
    pick.addEventListener('change', () => emit(true))
    hex.addEventListener('change', () => {
      const v = hexVec(hex.value)
      hex.classList.toggle('bad', !v)
      if (v) {
        pick.value = toHex(v).rgb
        emit(true)
      }
    })
    alpha.addEventListener('change', () => emit(true))
    ctl.append(pick, hex, prefixed('α', alpha))
  } else {
    const n = { vec2: 2, vec3: 3, vec4: 4 }[def.type]
    const boxes = Array.from({ length: n }, (_, i) =>
      h('input', {
        type: 'number',
        class: 'input num',
        step: 'any',
        value: num(shown[i] ?? 0),
        'aria-label': `${key} ${AXES[i]}`
      })
    )
    for (const b of boxes) {
      b.addEventListener('change', () =>
        change(
          boxes.map((x) => Number(x.value) || 0),
          true
        )
      )
    }
    ctl.classList.add('vec')
    ctl.append(...boxes.map((b, i) => prefixed(AXES[i] ?? '', b)))
  }
  const row = h(
    'div',
    { class: `field prow${value === undefined ? '' : ' set'}` },
    h(
      'div',
      { class: 'fl' },
      h('span', { class: 'flt', text: key, title: key }),
      reset
    ),
    ctl,
    liveEl
  )
  return {
    row,
    live(v) {
      const vec =
        typeof v === 'number'
          ? [v]
          : Array.isArray(v) || ArrayBuffer.isView(v)
            ? Array.from(v as ArrayLike<number>)
            : null
      const same =
        !!vec &&
        !!cur &&
        vec.length === cur.length &&
        vec.every((x, i) => Math.abs(x - (cur?.[i] ?? 0)) < 2e-3)
      const s = !vec || same ? '' : `now ${vec.map(num).join(', ')}`
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
    { class: 'select', 'aria-label': label },
    ...options.map((o) =>
      h('option', { value: o, text: o, selected: o === value })
    )
  )

/** A label and its control, two cells of the trigger form's grid. */
const field = (label: string, ...ctl: HTMLElement[]): HTMLElement =>
  h(
    'div',
    { class: 'frow' },
    h('span', { class: 'flt', text: label }),
    h('div', { class: 'fc' }, ...ctl)
  )

const numInput = (v: number, step: number, min?: number, max?: number) =>
  h('input', {
    type: 'number',
    class: 'input num',
    step,
    min,
    max,
    value: num(v)
  })

/** One trigger's form; `change` gets the edited trigger. */
export function triggerRow(
  t: TriggerConfig,
  change: (t: TriggerConfig) => void,
  fire: () => void,
  remove: () => void
): HTMLElement {
  const on = select(ONS, t.on, 'Event')
  const action = select(['to', 'rest', 'play', 'none'], actionOf(t), 'Action')
  const to = h('input', {
    type: 'text',
    class: 'input mono',
    placeholder: '{"progress": 1}',
    spellcheck: 'false',
    value: t.to && t.to !== 'rest' ? JSON.stringify(t.to) : ''
  })
  const play = select(
    ['forward', 'reverse', 'toggle'],
    t.play ?? 'forward',
    'Play'
  )
  const en = select(
    ['—', 'enable', 'disable'],
    t.enabled === undefined ? '—' : t.enabled ? 'enable' : 'disable',
    'Enabled'
  )
  const ease = select(
    [
      ...Object.keys(EASES),
      'spring',
      ...(easeName(t.ease) === 'custom' ? ['custom'] : [])
    ],
    easeName(t.ease),
    'Ease'
  )
  const spring = t.ease && 'spring' in t.ease ? t.ease.spring : {}
  const dur = numInput(t.duration ?? 0.4, 0.05, 0)
  const delay = numInput(t.delay ?? 0, 0.05, 0)
  const vd = numInput(spring.visualDuration ?? 0.3, 0.05, 0.01)
  const bounce = numInput(spring.bounce ?? 0, 0.05, 0, 1)
  const target = h('input', {
    type: 'text',
    class: 'input',
    placeholder: 'its own element',
    value: targetText(t.target)
  })
  const once = h('input', {
    type: 'checkbox',
    class: 'switch',
    checked: !!t.once,
    'aria-label': 'Once'
  })
  const unit = (el: HTMLElement, u: string): HTMLElement =>
    h('span', { class: 'ig' }, el, h('span', { class: 'post', text: u }))

  const rows = {
    to: field('To', to),
    play: field('Play', play),
    dur: field('Duration', unit(dur, 's')),
    vd: field('Settle', unit(vd, 's')),
    bounce: field('Bounce', bounce)
  }
  const sync = (): void => {
    const a = action.value as Action
    rows.to.hidden = a !== 'to'
    rows.play.hidden = a !== 'play'
    const sp = ease.value === 'spring'
    rows.dur.hidden = sp
    rows.vd.hidden = !sp
    rows.bounce.hidden = !sp
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
    // Kept, not edited here.
    if (t.threshold !== undefined) {
      out.threshold = t.threshold
    }
    if (t.rootMargin !== undefined) {
      out.rootMargin = t.rootMargin
    }
    if (t.past !== undefined) {
      out.past = t.past
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
  const fireBtn = h(
    'button',
    {
      class: 'btn secondary sm',
      type: 'button',
      title: 'Run this trigger from the rest values'
    },
    icon('play', 12),
    'Run'
  )
  fireBtn.addEventListener('click', fire)
  const del = h(
    'button',
    { class: 'btn ghost sm danger', type: 'button' },
    icon('trash', 14),
    'Remove'
  )
  del.addEventListener('click', remove)
  return h(
    'div',
    { class: 'tform' },
    h(
      'div',
      { class: 'grid' },
      field('Event', on),
      field('Action', action),
      rows.to,
      rows.play,
      field('Enabled', en),
      field('Ease', ease),
      rows.dur,
      rows.vd,
      rows.bounce,
      field('Delay', unit(delay, 's')),
      field('Target', target),
      field('Once', once)
    ),
    h('div', { class: 'tfoot' }, fireBtn, h('span', { class: 'spacer' }), del)
  )
}
