import type {
  EffectConfig,
  FxConfig,
  Match,
  ParamInput,
  TriggerConfig
} from '../fx/config'

// The editor's changes to a config (docs/EDITOR.md, E3), as pure
// functions from one FxConfig to the next, and the undo history over
// them. Effects are addressed by id (unique in a config).

interface MEffect {
  id: string
  effect: string
  params?: Record<string, ParamInput>
  enabled?: boolean
  media?: string
  triggers?: TriggerConfig[]
}
interface MGroup {
  match: Match
  effects: MEffect[]
}
interface MConfig {
  version: 1
  page?: MEffect[]
  elements?: MGroup[]
}

const copy = (c: FxConfig): MConfig => JSON.parse(JSON.stringify(c)) as MConfig

export const sameMatch = (a: Match, b: Match): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/** Every effect id in `c`. */
export function ids(c: FxConfig): Set<string> {
  const out = new Set<string>()
  for (const e of c.page ?? []) {
    out.add(e.id)
  }
  for (const g of c.elements ?? []) {
    for (const e of g.effects) {
      out.add(e.id)
    }
  }
  return out
}

/** `base`, or `base-2`, `base-3`... whichever `c` doesn't use. */
export function uniqueId(c: FxConfig, base: string): string {
  const taken = ids(c)
  if (!taken.has(base)) {
    return base
  }
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) {
      return `${base}-${n}`
    }
  }
}

/** The effect `id` and where it sits: on the page or under `match`. */
export function findEffect(
  c: FxConfig,
  id: string
): { effect: EffectConfig; match: Match | null } | null {
  for (const e of c.page ?? []) {
    if (e.id === id) {
      return { effect: e, match: null }
    }
  }
  for (const g of c.elements ?? []) {
    for (const e of g.effects) {
      if (e.id === id) {
        return { effect: e, match: g.match }
      }
    }
  }
  return null
}

/** Add effect `effect` as `id`, on the page (match null) or on the
 * elements `match` finds (joining an entry with the same match). */
export function addEffect(
  c: FxConfig,
  match: Match | null,
  effect: string,
  id: string
): FxConfig {
  const m = copy(c)
  const e: MEffect = { id, effect }
  if (!match) {
    m.page = [...(m.page ?? []), e]
    return m
  }
  m.elements ??= []
  const g = m.elements.find((x) => sameMatch(x.match, match))
  if (g) {
    g.effects.push(e)
  } else {
    m.elements.push({ match, effects: [e] })
  }
  return m
}

/** Remove effect `id`; an element entry left empty goes too. */
export function removeEffect(c: FxConfig, id: string): FxConfig {
  const m = copy(c)
  if (m.page) {
    m.page = m.page.filter((e) => e.id !== id)
    if (m.page.length === 0) {
      delete m.page
    }
  }
  if (m.elements) {
    for (const g of m.elements) {
      g.effects = g.effects.filter((e) => e.id !== id)
    }
    m.elements = m.elements.filter((g) => g.effects.length > 0)
    if (m.elements.length === 0) {
      delete m.elements
    }
  }
  return m
}

/** Apply `fn` to a copy of effect `id` (unchanged config if missing). */
export function editEffect(
  c: FxConfig,
  id: string,
  fn: (e: MEffect) => void
): FxConfig {
  const m = copy(c)
  for (const e of [
    ...(m.page ?? []),
    ...(m.elements ?? []).flatMap((g) => g.effects)
  ]) {
    if (e.id === id) {
      fn(e)
    }
  }
  return m
}

/** Set (or with undefined, unset) one rest param. */
export const setParam = (
  c: FxConfig,
  id: string,
  key: string,
  v: ParamInput | undefined
): FxConfig =>
  editEffect(c, id, (e) => {
    const p = { ...e.params }
    if (v === undefined) {
      delete p[key]
    } else {
      p[key] = v
    }
    if (Object.keys(p).length) {
      e.params = p
    } else {
      delete e.params
    }
  })

export const setEnabled = (c: FxConfig, id: string, on: boolean): FxConfig =>
  editEffect(c, id, (e) => {
    if (on) {
      delete e.enabled
    } else {
      e.enabled = false
    }
  })

/** Set (or with '', unset) the media query an effect needs. */
export const setMedia = (c: FxConfig, id: string, media: string): FxConfig =>
  editEffect(c, id, (e) => {
    if (media.trim()) {
      e.media = media.trim()
    } else {
      delete e.media
    }
  })

/** Replace trigger `index` of effect `id` (null removes it; index past
 * the end appends). */
export const setTrigger = (
  c: FxConfig,
  id: string,
  index: number,
  t: TriggerConfig | null
): FxConfig =>
  editEffect(c, id, (e) => {
    const ts = [...(e.triggers ?? [])]
    if (t === null) {
      ts.splice(index, 1)
    } else {
      ts[Math.min(index, ts.length)] = t
    }
    if (ts.length) {
      e.triggers = ts
    } else {
      delete e.triggers
    }
  })

/**
 * Undo and redo over whole configs. push() records the config before a
 * change; a change with the same `coalesce` key as the previous one
 * within `windowMs` (a slider drag) joins it.
 */
export class History {
  private past: string[] = []
  private future: string[] = []
  private last: { key: string; at: number } | null = null

  constructor(
    private readonly limit = 100,
    private readonly windowMs = 1500
  ) {}

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  push(before: FxConfig, coalesce: string | undefined, now: number): void {
    const joins =
      coalesce !== undefined &&
      this.last?.key === coalesce &&
      now - this.last.at < this.windowMs
    this.last = coalesce === undefined ? null : { key: coalesce, at: now }
    this.future = []
    if (joins) {
      return
    }
    this.past.push(JSON.stringify(before))
    if (this.past.length > this.limit) {
      this.past.shift()
    }
  }

  undo(current: FxConfig): FxConfig | null {
    const s = this.past.pop()
    if (s === undefined) {
      return null
    }
    this.future.push(JSON.stringify(current))
    this.last = null
    return JSON.parse(s) as FxConfig
  }

  redo(current: FxConfig): FxConfig | null {
    const s = this.future.pop()
    if (s === undefined) {
      return null
    }
    this.past.push(JSON.stringify(current))
    this.last = null
    return JSON.parse(s) as FxConfig
  }
}
