import type { Effects } from './effects'
import { type ParamSchema, parseHex } from './params'
import { type EffectDef, type EffectHandle, getEffect } from './registry'
import { Animator, DEFAULT_EASE, type Timing } from './tween'

// Effects from a JSON config (docs/EDITOR.md): registry effects
// (registry.ts) on the page or on matched elements, with triggers that
// tween their params (tween.ts). The editor changes effects only through
// update(), so editing and production run the same code. Inert on an
// inert runtime apart from creating the (inert) effects: no listeners.

export type Match = { fx: string } | { selector: string }

/** A number, an array for vectors and colours, or a '#rrggbb[aa]'
 * colour. */
export type ParamInput = number | readonly number[] | string

export type ParamInputs = Readonly<Record<string, ParamInput>>

export type TriggerOn =
  | 'load'
  | 'enter'
  | 'exit'
  | 'pointerenter'
  | 'pointerleave'
  | 'pointerdown'
  | 'pointerup'
  | 'click'

export interface TriggerConfig extends Timing {
  on: TriggerOn
  /** Listen on these elements instead of the effect's own (required for
   * a page effect's enter/exit/pointerenter/pointerleave; a page
   * effect's click/pointerdown/pointerup default to the document). */
  target?: Match
  /** enter/exit: IntersectionObserver threshold. Default 0. */
  threshold?: number
  /** Fire once, then stop listening. */
  once?: boolean
  /** Params to tween to, or 'rest' (the effect's `params`). */
  to?: ParamInputs | 'rest'
  /** true: enable first; false: disable at once, or after `to` lands. */
  enabled?: boolean
  /** Tween `progress` to 1, 0 or the other end; a one-shot effect
   * (EffectDef.impulse) starts instead. */
  play?: 'forward' | 'reverse' | 'toggle'
}

export interface EffectConfig {
  /** Unique in the file. */
  id: string
  /** A registry id (`spotlight`, `blur`, ...). */
  effect: string
  /** Rest values; unset params keep the effect's defaults. */
  params?: ParamInputs
  /** Default true. */
  enabled?: boolean
  triggers?: readonly TriggerConfig[]
}

export interface ElementConfig {
  match: Match
  effects: readonly EffectConfig[]
}

export interface FxConfig {
  version: 1
  page?: readonly EffectConfig[]
  elements?: readonly ElementConfig[]
}

/** Time source (tests pin it). */
export interface ConfigClock {
  now(): number
  request(cb: (now: number) => void): number
  cancel(id: number): void
}

export interface ConfigOptions {
  /** Where matches are looked up. Default document. */
  root?: ParentNode
  clock?: ConfigClock
}

/** One created effect (devtools' Edit tab lists them). */
export interface ConfigInstance {
  readonly id: string
  readonly effect: string
  /** null for a page effect. */
  readonly el: Element | null
  readonly cfg: EffectConfig
  readonly handle: EffectHandle
}

export interface LiveConfig {
  /** The config last applied. */
  readonly config: FxConfig
  /** Bumped by every update() or resolve() that changed something. */
  readonly version: number
  /** Every created effect, page effects first, in config order. */
  instances(): ConfigInstance[]
  /** Apply `config`: effects whose entry is unchanged keep running as
   * they are; changed ones are reset to their rest values; an equal
   * config does nothing. */
  update(config: FxConfig): void
  /** Run a trigger of effect `id` by index or by its `on`; with
   * `fromRest`, from the rest values (an editor's preview: a `play
   * forward` that already ran plays again). */
  fire(
    id: string,
    trigger: number | TriggerOn,
    opts?: { fromRest?: boolean }
  ): void
  /** The handles of effect `id` (one per matched element). */
  get(id: string): EffectHandle[]
  /** Match elements again (content mounted after apply). */
  resolve(): void
  destroy(): void
}

type Vals = Record<string, number[]>

const lives = new Set<LiveConfig>()

/** The configs applied on this page and not destroyed (devtools). */
export function liveConfigs(): LiveConfig[] {
  return [...lives]
}

interface Entry {
  cfg: EffectConfig
  def: EffectDef
  page: boolean
  insts: Map<Element | null, Instance>
}

interface Instance {
  entry: Entry
  el: Element | null
  handle: EffectHandle
  /** Params right after creation (the effect's own defaults). */
  base: Vals
  /** base with the config's params: what `to: 'rest'` returns to. */
  rest: Vals
  anim: Animator
  /** The end `play` last went to. */
  dir: 0 | 1
  off: (() => void)[]
}

const warn = (msg: string): void => {
  console.warn(`fx config: ${msg}`)
}

const same = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b)

const toVec = (v: unknown): number[] | null => {
  if (typeof v === 'number') {
    return [v]
  }
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    return Array.from(v as ArrayLike<number>)
  }
  return null
}

/** A config value as the channel array of `key`, or null when the
 * schema has no such param or the value doesn't fit it. */
export function paramVec(
  schema: ParamSchema,
  key: string,
  v: ParamInput | undefined
): number[] | null {
  const def = schema[key]
  if (!def || v === undefined) {
    return null
  }
  if (typeof v === 'string') {
    return def.type === 'color' ? parseHex(v) : null
  }
  return toVec(v)
}

const vecs = (def: EffectDef, inputs: ParamInputs, id: string): Vals => {
  const out: Vals = {}
  for (const [k, v] of Object.entries(inputs)) {
    const vec = paramVec(def.schema, k, v)
    if (vec) {
      out[k] = vec
    } else {
      warn(`${id}: ${def.id} has no param '${k}' taking ${JSON.stringify(v)}`)
    }
  }
  return out
}

const cssEscape = (s: string): string =>
  typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(s)
    : s.replace(/["\\]/g, '\\$&')

const defaultClock = (): ConfigClock => ({
  now: () => performance.now(),
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id)
})

/** Build the effects of `config` and keep them in step with update(). */
export function applyConfig(
  fx: Effects,
  config: FxConfig,
  opts: ConfigOptions = {}
): LiveConfig {
  const root: ParentNode = opts.root ?? document
  const doc: EventTarget = (root as Node).ownerDocument ?? root
  const clock = opts.clock ?? defaultClock()
  const entries = new Map<string, Entry>()
  let current: FxConfig = { version: 1 }
  let raf = 0
  let destroyed = false
  let version = 0

  const match = (m: Match): Element[] => {
    const sel = 'fx' in m ? `[data-fx="${cssEscape(m.fx)}"]` : m.selector
    try {
      return Array.from(root.querySelectorAll(sel))
    } catch {
      warn(`bad selector ${JSON.stringify(sel)}`)
      return []
    }
  }

  const tick = (now: number): void => {
    raf = 0
    let more = false
    for (const e of entries.values()) {
      for (const inst of e.insts.values()) {
        if (inst.anim.running && inst.anim.step(now)) {
          more = true
        }
      }
    }
    if (more) {
      raf = clock.request(tick)
    }
  }
  const kick = (): void => {
    if (!raf && !destroyed) {
      raf = clock.request(tick)
    }
  }

  const write = (inst: Instance, key: string, v: number[]): void => {
    const t = inst.entry.def.schema[key]?.type
    inst.handle.params[key] = t === 'f32' ? (v[0] ?? 0) : v
  }
  const currentVec = (inst: Instance, key: string): number[] =>
    toVec(inst.anim.value(key)) ??
    toVec(inst.handle.params[key]) ??
    inst.rest[key] ?? [0]

  const run = (
    inst: Instance,
    t: TriggerConfig,
    at: Element | readonly [number, number] | null
  ): void => {
    const { def, cfg } = inst.entry
    const timing: Timing = fx.reducedMotion
      ? { duration: 0, ease: DEFAULT_EASE }
      : t
    if (t.enabled === true) {
      inst.handle.enabled = true
    }
    let goals: Vals = {}
    if (t.to === 'rest') {
      goals = { ...inst.rest }
    } else if (t.to) {
      goals = vecs(def, t.to, cfg.id)
    }
    if (t.play) {
      if (def.impulse) {
        inst.handle.play?.(at ?? inst.el)
      } else if (def.schema.progress) {
        const g =
          t.play === 'forward'
            ? 1
            : t.play === 'reverse'
              ? 0
              : inst.dir === 1
                ? 0
                : 1
        inst.dir = g
        goals.progress = [g]
      } else {
        warn(`${cfg.id}: ${def.id} has nothing to play`)
      }
    }
    const disable = t.enabled === false
    if (Object.keys(goals).length > 0) {
      inst.anim.to(
        goals,
        (k) => currentVec(inst, k),
        timing,
        clock.now(),
        disable
          ? () => {
              inst.handle.enabled = false
            }
          : undefined
      )
      kick()
    } else if (disable) {
      inst.handle.enabled = false
    }
  }

  /** enter/exit through one IntersectionObserver over `els`; returns
   * its disconnect. */
  const observe = (
    t: TriggerConfig,
    els: Element[],
    go: (at: Element) => void
  ): (() => void) | null => {
    if (typeof IntersectionObserver === 'undefined') {
      return null
    }
    const inside = new Set<Element>()
    const io = new IntersectionObserver(
      (records) => {
        for (const r of records) {
          if (r.isIntersecting === inside.has(r.target)) {
            continue
          }
          if (r.isIntersecting) {
            inside.add(r.target)
          } else {
            inside.delete(r.target)
          }
          if (r.isIntersecting === (t.on === 'enter')) {
            go(r.target)
          }
        }
      },
      { threshold: t.threshold ?? 0 }
    )
    for (const el of els) {
      io.observe(el)
    }
    return () => io.disconnect()
  }

  const bind = (inst: Instance): void => {
    const { cfg } = inst.entry
    for (const t of cfg.triggers ?? []) {
      if (t.on === 'load') {
        run(inst, t, inst.el)
        continue
      }
      if (!fx.active) {
        continue
      }
      const els = t.target ? match(t.target) : inst.el ? [inst.el] : []
      let stop: (() => void) | null = null
      let fired = false
      const go = (at: Element | readonly [number, number] | null): void => {
        if (t.once) {
          if (fired) {
            return
          }
          fired = true
          // After the current dispatch.
          queueMicrotask(() => {
            const i = stop ? inst.off.indexOf(stop) : -1
            if (i >= 0) {
              inst.off.splice(i, 1)
              stop?.()
            }
          })
        }
        run(inst, t, at)
      }
      if (t.on === 'enter' || t.on === 'exit') {
        if (els.length === 0 && !t.target && !inst.el) {
          warn(`${cfg.id}: '${t.on}' on a page effect needs a target`)
        }
        stop = observe(t, els, go)
      } else {
        const docEvent =
          t.on === 'click' || t.on === 'pointerdown' || t.on === 'pointerup'
        const targets: EventTarget[] =
          els.length > 0 ? els : !t.target && docEvent ? [doc] : []
        if (targets.length === 0 && !t.target) {
          warn(`${cfg.id}: '${t.on}' on a page effect needs a target`)
        }
        const on = t.on
        const h = (e: Event): void => {
          const p = e as Partial<MouseEvent>
          const cur: unknown = e.currentTarget
          go(
            docEvent && typeof p.pageX === 'number'
              ? [p.pageX, p.pageY ?? 0]
              : cur === doc
                ? null
                : (cur as Element | null)
          )
        }
        for (const el of targets) {
          el.addEventListener(on, h)
        }
        stop = () => {
          for (const el of targets) {
            el.removeEventListener(on, h)
          }
        }
      }
      if (stop) {
        inst.off.push(stop)
      }
    }
  }

  const unbind = (inst: Instance): void => {
    for (const off of inst.off.splice(0)) {
      off()
    }
  }

  const configure = (inst: Instance): void => {
    unbind(inst)
    inst.anim.stop()
    const { cfg, def } = inst.entry
    inst.rest = { ...inst.base, ...vecs(def, cfg.params ?? {}, cfg.id) }
    for (const [k, v] of Object.entries(inst.rest)) {
      write(inst, k, v)
    }
    inst.handle.enabled = cfg.enabled ?? true
    inst.dir = (inst.rest.progress?.[0] ?? 0) >= 0.5 ? 1 : 0
    bind(inst)
  }

  /** Write the rest params that changed; the others stay where they
   * are (a played `progress` stays played). */
  const retune = (inst: Instance): void => {
    const { cfg, def } = inst.entry
    const prev = inst.rest
    inst.rest = { ...inst.base, ...vecs(def, cfg.params ?? {}, cfg.id) }
    for (const [k, v] of Object.entries(inst.rest)) {
      if (!same(prev[k], v)) {
        inst.anim.stop(k)
        write(inst, k, v)
      }
    }
  }

  const create = (entry: Entry, el: Element | null): Instance | null => {
    let handle: EffectHandle
    try {
      handle = entry.def.create(fx, el)
    } catch (e) {
      warn(`${entry.cfg.id}: ${(e as Error).message}`)
      return null
    }
    const base: Vals = {}
    for (const [k, d] of Object.entries(entry.def.schema)) {
      const v =
        toVec(handle.params[k]) ??
        (typeof d.default === 'string' ? parseHex(d.default) : toVec(d.default))
      if (v) {
        base[k] = v
      }
    }
    const inst: Instance = {
      entry,
      el,
      handle,
      base,
      rest: base,
      anim: new Animator((k, v) => write(inst, k, v)),
      dir: 0,
      off: []
    }
    entry.insts.set(el, inst)
    configure(inst)
    return inst
  }

  const drop = (inst: Instance): void => {
    unbind(inst)
    inst.anim.stop()
    inst.handle.destroy()
  }

  const update = (next: FxConfig, force: boolean): void => {
    if (destroyed || (!force && same(next, current))) {
      current = next
      return
    }
    version++
    if (next.version !== 1) {
      warn(`unknown version ${String(next.version)}`)
    }
    current = next
    const wanted = new Map<
      string,
      { cfg: EffectConfig; page: boolean; els: (Element | null)[] }
    >()
    const want = (
      cfg: EffectConfig,
      page: boolean,
      els: (Element | null)[]
    ): void => {
      if (wanted.has(cfg.id)) {
        warn(`duplicate id '${cfg.id}'`)
        return
      }
      wanted.set(cfg.id, { cfg, page, els })
    }
    for (const cfg of next.page ?? []) {
      want(cfg, true, [null])
    }
    for (const ec of next.elements ?? []) {
      const els = match(ec.match)
      for (const cfg of ec.effects) {
        want(cfg, false, els)
      }
    }
    for (const [id, e] of entries) {
      const w = wanted.get(id)
      if (!w || w.cfg.effect !== e.def.id || w.page !== e.page) {
        for (const inst of e.insts.values()) {
          drop(inst)
        }
        entries.delete(id)
      }
    }
    for (const [id, w] of wanted) {
      const def = getEffect(w.cfg.effect)
      if (!def) {
        warn(`${id}: no effect '${w.cfg.effect}'`)
        continue
      }
      if (!def.scopes.includes(w.page ? 'page' : 'element')) {
        warn(`${id}: ${def.id} can't go on the ${w.page ? 'page' : 'element'}`)
        continue
      }
      let e = entries.get(id)
      const changed = !!e && !same(e.cfg, w.cfg)
      // Only rest params changed (a slider in the editor): retune in
      // place, without rebinding triggers or running `load` again.
      const paramsOnly =
        changed &&
        !!e &&
        same({ ...e.cfg, params: undefined }, { ...w.cfg, params: undefined })
      if (!e) {
        e = { cfg: w.cfg, def, page: w.page, insts: new Map() }
        entries.set(id, e)
      }
      e.cfg = w.cfg
      e.def = def
      for (const [el, inst] of e.insts) {
        if (!w.els.includes(el)) {
          drop(inst)
          e.insts.delete(el)
        }
      }
      for (const el of w.els) {
        const inst = e.insts.get(el)
        if (!inst) {
          create(e, el)
        } else if (paramsOnly) {
          retune(inst)
        } else if (changed) {
          configure(inst)
        }
      }
    }
  }

  update(config, true)

  const live: LiveConfig = {
    get config() {
      return current
    },
    get version() {
      return version
    },
    instances() {
      const out: ConfigInstance[] = []
      for (const e of entries.values()) {
        for (const i of e.insts.values()) {
          out.push({
            id: e.cfg.id,
            effect: e.def.id,
            el: i.el,
            cfg: e.cfg,
            handle: i.handle
          })
        }
      }
      return out.sort((a, b) => Number(b.el === null) - Number(a.el === null))
    },
    update: (c) => update(c, false),
    fire(id, which, opts) {
      const e = entries.get(id)
      const ts = e?.cfg.triggers ?? []
      const t =
        typeof which === 'number' ? ts[which] : ts.find((x) => x.on === which)
      if (!e || !t) {
        warn(`no trigger ${String(which)} on '${id}'`)
        return
      }
      for (const inst of e.insts.values()) {
        if (opts?.fromRest) {
          inst.anim.stop()
          for (const [k, v] of Object.entries(inst.rest)) {
            write(inst, k, v)
          }
          inst.handle.enabled = e.cfg.enabled ?? true
          inst.dir = (inst.rest.progress?.[0] ?? 0) >= 0.5 ? 1 : 0
        }
        run(inst, t, inst.el)
      }
    },
    get: (id) =>
      [...(entries.get(id)?.insts.values() ?? [])].map((i) => i.handle),
    resolve: () => update(current, true),
    destroy() {
      if (destroyed) {
        return
      }
      destroyed = true
      lives.delete(live)
      if (raf) {
        clock.cancel(raf)
        raf = 0
      }
      for (const e of entries.values()) {
        for (const inst of e.insts.values()) {
          drop(inst)
        }
      }
      entries.clear()
    }
  }
  lives.add(live)
  return live
}
