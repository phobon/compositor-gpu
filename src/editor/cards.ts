import type { ConfigInstance, ParamInput, TriggerConfig } from '../fx/config'
import { h } from '../util/h'
import {
  findEffect,
  removeEffect,
  setEnabled,
  setMedia,
  setParam,
  setTrigger
} from './edits'
import { easeName, paramRow, triggerRow } from './form'
import { icon } from './icons'
import type { EditSession } from './session'

// The editor's effect card (docs/EDITOR.md): enabled, media, remove, a
// row per param, and the triggers, each a one-line summary that opens to
// its fields. Edits go through the session; `rebuild` asks the UI for a
// fresh card after a structural change (a trigger added or removed, a
// param reset).

const toVec = (v: unknown): number[] | null =>
  typeof v === 'number'
    ? [v]
    : Array.isArray(v) || ArrayBuffer.isView(v)
      ? Array.from(v as ArrayLike<number>)
      : null

/** A param row's live readout. */
export interface LiveRow {
  handle: ConfigInstance['handle']
  key: string
  live(v: unknown): void
}

/** `pointerenter → to {"progress":0.35} · spring`. */
export function triggerSummary(t: TriggerConfig): string {
  const what = t.play
    ? `play ${t.play}`
    : t.to === 'rest'
      ? 'to rest'
      : t.to
        ? `to ${JSON.stringify(t.to)}`
        : ''
  const en = t.enabled === undefined ? '' : t.enabled ? 'enable' : 'disable'
  const ease = easeName(t.ease)
  const time = ease === 'spring' ? 'spring' : `${t.duration ?? 0.4}s ${ease}`
  return [`${t.on} → ${[what, en].filter(Boolean).join(', ') || '—'}`, time]
    .concat(t.once ? ['once'] : [])
    .join(' · ')
}

export function effectCard(
  s: EditSession,
  i: ConfigInstance,
  opts: {
    copies: number
    open: boolean
    liveRows: LiveRow[]
    rebuild: () => void
  }
): HTMLElement {
  const def = s.mods?.registry.getEffect(i.effect)
  const cfg = (() => {
    const live = s.live()
    return live ? findEffect(live.config, i.id)?.effect : undefined
  })()
  const now = () => s.live()?.config ?? null
  const enabled = h('input', {
    type: 'checkbox',
    class: 'switch',
    checked: cfg?.enabled ?? true,
    title: 'Enabled at rest',
    'aria-label': `${i.id} enabled`
  })
  enabled.addEventListener('click', (e) => e.stopPropagation())
  enabled.addEventListener('change', () => {
    const c = now()
    if (c) {
      s.commit(setEnabled(c, i.id, enabled.checked))
    }
  })
  const media = h('input', {
    type: 'text',
    class: 'input',
    placeholder: 'Any',
    value: cfg?.media ?? '',
    title: 'Only while this media query matches'
  })
  media.addEventListener('change', () => {
    const c = now()
    if (c) {
      s.commit(setMedia(c, i.id, media.value))
    }
  })
  const remove = h(
    'button',
    {
      class: 'btn ghost icon sm',
      type: 'button',
      title: `Remove ${i.id}`,
      'aria-label': `Remove ${i.id}`
    },
    icon('trash', 14)
  )
  remove.addEventListener('click', (e) => {
    e.preventDefault()
    const c = now()
    if (c) {
      s.commit(removeEffect(c, i.id))
      opts.rebuild()
    }
  })

  const params: HTMLElement[] = []
  for (const [key, pd] of Object.entries(def?.schema ?? {})) {
    const value = cfg?.params?.[key]
    const shown =
      (value !== undefined && def
        ? s.mods?.config.paramVec(def.schema, key, value)
        : null) ??
      toVec(i.handle.params[key]) ??
      []
    const r = paramRow(key, pd, value, shown, (v, done) => {
      const c = now()
      if (!c) {
        return
      }
      s.commit(
        setParam(c, i.id, key, v as ParamInput | undefined),
        `${i.id}.${key}`
      )
      if (done && v === undefined) {
        opts.rebuild()
      }
    })
    opts.liveRows.push({ handle: i.handle, key, live: r.live })
    params.push(r.row)
  }

  const triggers = (cfg?.triggers ?? []).map((t, n) => {
    const text = h('span', { class: 'tsum', text: triggerSummary(t) })
    const fire = h(
      'button',
      {
        class: 'btn ghost icon xs',
        type: 'button',
        title: 'Run this trigger from the rest values',
        'aria-label': 'Run'
      },
      icon('play', 12)
    )
    fire.addEventListener('click', (e) => {
      e.preventDefault()
      s.live()?.fire(i.id, n, { fromRest: true })
    })
    return h(
      'details',
      { class: 'trig' },
      h('summary', {}, fire, text, icon('chevronRight', 14)),
      triggerRow(
        t,
        (next) => {
          const c = now()
          if (c) {
            s.commit(setTrigger(c, i.id, n, next))
            text.textContent = triggerSummary(next)
          }
        },
        () => s.live()?.fire(i.id, n, { fromRest: true }),
        () => {
          const c = now()
          if (c) {
            s.commit(setTrigger(c, i.id, n, null))
            opts.rebuild()
          }
        }
      )
    )
  })
  const addTrigger = h(
    'button',
    { class: 'btn ghost sm', type: 'button', title: 'Add a trigger' },
    icon('plus', 14),
    'Add'
  )
  addTrigger.addEventListener('click', () => {
    const c = now()
    if (c) {
      s.commit(
        setTrigger(c, i.id, cfg?.triggers?.length ?? 0, {
          on: 'pointerenter',
          to: 'rest'
        })
      )
      opts.rebuild()
    }
  })

  return h(
    'details',
    { class: 'sec', open: opts.open, 'data-id': i.id },
    h(
      'summary',
      { class: 'sh' },
      icon('chevronRight', 14),
      h('span', { class: 'name', text: i.id }),
      h('span', { class: 'badge', text: i.effect }),
      opts.copies > 1
        ? h('span', { class: 'muted', text: `×${opts.copies}` })
        : null,
      h('span', { class: 'spacer' }),
      enabled,
      remove
    ),
    h(
      'div',
      { class: 'sb' },
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'fl' }, h('span', { class: 'flt', text: 'Media' })),
        h('div', { class: 'fc' }, media)
      ),
      def
        ? h('div', { class: 'params' }, ...params)
        : h('p', {
            class: 'note',
            text: `No registered effect '${i.effect}'.`
          }),
      h(
        'div',
        { class: 'subhead' },
        h('span', { text: 'Triggers' }),
        addTrigger
      ),
      triggers.length
        ? h('div', { class: 'trigs' }, ...triggers)
        : h('p', {
            class: 'muted small',
            text: 'None: the effect sits at rest.'
          })
    )
  )
}

/** A select of the effects for `scope` and an Add button. */
export function addPicker(
  s: EditSession,
  scope: 'page' | 'element',
  el: Element | null,
  added: (id: string) => void
): HTMLElement {
  const defs = s.effectDefs(scope)
  const pick = h(
    'select',
    { class: 'select', 'aria-label': 'Effect to add' },
    ...defs.map((d) => h('option', { value: d.id, text: d.label }))
  )
  const add = h(
    'button',
    { class: 'btn primary', type: 'button' },
    icon('plus', 14),
    'Add effect'
  )
  add.addEventListener('click', () => {
    const def = defs.find((d) => d.id === pick.value)
    const id = def ? s.add(def, el) : null
    if (id) {
      added(id)
    }
  })
  return h('div', { class: 'addfx' }, pick, add)
}
