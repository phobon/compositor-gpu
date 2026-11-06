import type { EffectConfig, FxConfig, Match } from '../fx/config'

// The editor's config files (docs/EDITOR.md, E4), without the browser:
// reading and writing their text, and what differs between two configs.

/** The file's text: two-space JSON and a final newline. */
export const serialize = (c: FxConfig): string =>
  `${JSON.stringify(c, null, 2)}\n`

/** Parse a config file; throws with a reason when it isn't one. */
export function parseConfig(text: string): FxConfig {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch (e) {
    throw new Error(`not JSON (${(e as Error).message})`)
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('not a JSON object')
  }
  const c = v as Record<string, unknown>
  if (c.version !== 1) {
    throw new Error(`version ${JSON.stringify(c.version)}, expected 1`)
  }
  const effects = (list: unknown, where: string): void => {
    if (!Array.isArray(list)) {
      throw new Error(`${where} is not an array`)
    }
    for (const e of list) {
      const x = e as Record<string, unknown> | null
      if (!x || typeof x.id !== 'string' || typeof x.effect !== 'string') {
        throw new Error(`${where}: an effect without a string id and effect`)
      }
    }
  }
  if (c.page !== undefined) {
    effects(c.page, 'page')
  }
  if (c.elements !== undefined) {
    if (!Array.isArray(c.elements)) {
      throw new Error('elements is not an array')
    }
    c.elements.forEach((g: unknown, i) => {
      const x = g as Record<string, unknown> | null
      const m = x?.match as Record<string, unknown> | undefined
      if (!m || (typeof m.fx !== 'string' && typeof m.selector !== 'string')) {
        throw new Error(`elements[${i}] has no match`)
      }
      effects(x?.effects, `elements[${i}].effects`)
    })
  }
  return c as unknown as FxConfig
}

export interface ConfigDiff {
  /** Ids only in `b`. */
  added: string[]
  /** Ids only in `a`. */
  removed: string[]
  /** Ids in both whose entry or match differ. */
  changed: string[]
}

const byId = (c: FxConfig): Map<string, string> => {
  const out = new Map<string, string>()
  const put = (e: EffectConfig, m: Match | null): void => {
    out.set(e.id, JSON.stringify([m, e]))
  }
  for (const e of c.page ?? []) {
    put(e, null)
  }
  for (const g of c.elements ?? []) {
    for (const e of g.effects) {
      put(e, g.match)
    }
  }
  return out
}

/** What `b` changes relative to `a`, by effect id. */
export function diffConfigs(a: FxConfig, b: FxConfig): ConfigDiff {
  const x = byId(a)
  const y = byId(b)
  const d: ConfigDiff = { added: [], removed: [], changed: [] }
  for (const [id, v] of y) {
    const u = x.get(id)
    if (u === undefined) {
      d.added.push(id)
    } else if (u !== v) {
      d.changed.push(id)
    }
  }
  for (const id of x.keys()) {
    if (!y.has(id)) {
      d.removed.push(id)
    }
  }
  return d
}

/** `+2 −1 ~3`, or '' when equal. */
export function describeDiff(d: ConfigDiff): string {
  return [
    d.added.length ? `+${d.added.length}` : '',
    d.removed.length ? `−${d.removed.length}` : '',
    d.changed.length ? `~${d.changed.length}` : ''
  ]
    .filter(Boolean)
    .join(' ')
}
