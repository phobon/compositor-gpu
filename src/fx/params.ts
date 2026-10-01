// Params: a schema → a Proxy of plain numbers / float arrays, the WGSL
// `struct Params` it implies, and a Float32Array packed in that struct's
// uniform layout. See src/fx/README.md.

export type ParamType = 'f32' | 'vec2' | 'vec3' | 'vec4' | 'color'

export interface ParamDef {
  type: ParamType
  /** A number for f32; an array for vectors; '#rrggbb[aa]' or [r,g,b,a]
   * for colour. */
  default: number | readonly number[] | string
  /** Metadata for UIs; writes are not clamped. */
  min?: number
  max?: number
}

export type ParamSchema = Record<string, ParamDef>

/** The live object a schema exposes. Vectors and colours are arrays of
 * floats (colours [r,g,b,a], sRGB-encoded, unpremultiplied); a colour also
 * accepts a hex string on assignment (`Object.assign(p, { tint: '#f00' })`). */
export type ParamValues<S extends ParamSchema> = {
  -readonly [K in keyof S]: ParamValue<S[K]['type']>
}

/** number for f32, number[] otherwise (both for the ParamType union). */
export type ParamValue<T extends ParamType> = T extends 'f32'
  ? number
  : number[]

interface Field {
  name: string
  type: ParamType
  /** Float offset into the packed block. */
  offset: number
  /** Components. */
  n: number
}

const WGSL_TYPE: Record<ParamType, string> = {
  f32: 'f32',
  vec2: 'vec2f',
  vec3: 'vec3f',
  vec4: 'vec4f',
  color: 'vec4f'
}
const COMPONENTS: Record<ParamType, number> = {
  f32: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
  color: 4
}
/** WGSL uniform alignment in bytes (vec3 aligns like vec4). */
const ALIGN: Record<ParamType, number> = {
  f32: 4,
  vec2: 8,
  vec3: 16,
  vec4: 16,
  color: 16
}

const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/

/** '#rgb', '#rgba', '#rrggbb', '#rrggbbaa' → [r,g,b,a] in 0..1. */
export function parseHex(hex: string): number[] | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(hex.trim())
  const h = m?.[1]
  if (!h || ![3, 4, 6, 8].includes(h.length)) {
    return null
  }
  const short = h.length <= 4
  const out: number[] = []
  for (let i = 0; i < (short ? h.length : h.length / 2); i++) {
    const s = short ? (h[i] ?? '0').repeat(2) : h.slice(i * 2, i * 2 + 2)
    out.push(Number.parseInt(s, 16) / 255)
  }
  if (out.length === 3) {
    out.push(1)
  }
  return out
}

function toComponents(type: ParamType, v: unknown): number[] | null {
  const n = COMPONENTS[type]
  if (type === 'color' && typeof v === 'string') {
    return parseHex(v)
  }
  if (typeof v === 'number') {
    return n === 1 ? [v] : null
  }
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const a = Array.from(v as ArrayLike<number>, Number)
    if (type === 'color' && a.length === 3) {
      a.push(1)
    }
    return a.length === n ? a : null
  }
  return null
}

export interface ParamBlock<S extends ParamSchema> {
  readonly values: ParamValues<S>
  /** `struct Params { ... }` in WGSL. */
  readonly wgsl: string
  /** Size of the uniform block, bytes (a multiple of 16). */
  readonly byteSize: number
  /** True after a write until pack(). */
  dirty: boolean
  /** The packed block (re-packed when dirty). */
  pack(): Float32Array
}

/**
 * Build the parameter block for `schema`. `onWrite` runs on every write
 * that changes a value (including element writes on vector arrays).
 * Throws on a name that isn't a WGSL identifier or a default that doesn't
 * fit its type.
 */
export function createParams<S extends ParamSchema>(
  schema: S,
  onWrite: () => void
): ParamBlock<S> {
  const fields: Field[] = []
  let bytes = 0
  for (const [name, def] of Object.entries(schema)) {
    if (!IDENT.test(name)) {
      throw new Error(
        `[compositor-gpu/fx] param name '${name}' is not a WGSL identifier`
      )
    }
    const align = ALIGN[def.type]
    bytes = Math.ceil(bytes / align) * align
    fields.push({
      name,
      type: def.type,
      offset: bytes / 4,
      n: COMPONENTS[def.type]
    })
    bytes += COMPONENTS[def.type] * 4
  }
  // A uniform struct's size rounds up to its alignment; the binding is
  // padded to 16 so an empty schema still has a valid buffer.
  const byteSize = Math.max(16, Math.ceil(bytes / 16) * 16)
  const data = new Float32Array(byteSize / 4)

  const lines = fields.map(
    (f) => `  ${f.name} : ${WGSL_TYPE[f.type]},  // offset ${f.offset * 4}`
  )
  if (lines.length === 0) {
    lines.push('  _unused : f32,')
  }
  const wgsl = `struct Params {\n${lines.join('\n')}\n};\n`

  const block = {
    values: {} as ParamValues<S>,
    wgsl,
    byteSize,
    dirty: true,
    pack(): Float32Array {
      if (block.dirty) {
        for (const f of fields) {
          const v = store[f.name]
          if (typeof v === 'number') {
            data[f.offset] = v
          } else if (v) {
            for (let i = 0; i < f.n; i++) {
              data[f.offset + i] = v.raw[i] ?? 0
            }
          }
        }
        block.dirty = false
      }
      return data
    }
  }
  const touch = (): void => {
    block.dirty = true
    onWrite()
  }

  interface Vec {
    raw: number[]
    proxy: number[]
  }
  const store: Record<string, number | Vec> = {}
  const extra: Record<string | symbol, unknown> = {}
  const byName = new Map(fields.map((f) => [f.name, f]))

  const makeVec = (raw: number[]): Vec => {
    // Element writes (`params.tint[3] = 0.5`, or a tween addressing
    // indices) mark dirty too; other keys (a tween library's cache) pass
    // through untouched.
    const proxy = new Proxy(raw, {
      set(target, key, value) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          const i = Number(key)
          if (i >= target.length) {
            return true
          }
          const v = Number(value)
          if (target[i] !== v) {
            target[i] = v
            touch()
          }
          return true
        }
        return Reflect.set(target, key, value)
      }
    })
    return { raw, proxy }
  }

  for (const f of fields) {
    const def = schema[f.name] as ParamDef
    const c = toComponents(f.type, def.default)
    if (!c) {
      throw new Error(
        `[compositor-gpu/fx] param '${f.name}': default doesn't fit ${f.type}`
      )
    }
    store[f.name] = f.n === 1 ? (c[0] ?? 0) : makeVec(c)
  }

  block.values = new Proxy({} as ParamValues<S>, {
    get(_t, key) {
      if (typeof key === 'string' && byName.has(key)) {
        const v = store[key]
        return typeof v === 'number' ? v : v?.proxy
      }
      return extra[key]
    },
    set(_t, key, value) {
      const f = typeof key === 'string' ? byName.get(key) : undefined
      if (!f) {
        extra[key] = value
        return true
      }
      const c = toComponents(f.type, value)
      if (!c) {
        return true
      }
      const cur = store[f.name]
      if (typeof cur === 'number') {
        const v = c[0] ?? 0
        if (v !== cur) {
          store[f.name] = v
          touch()
        }
      } else if (cur) {
        let changed = false
        for (let i = 0; i < f.n; i++) {
          const v = c[i] ?? 0
          if (cur.raw[i] !== v) {
            cur.raw[i] = v
            changed = true
          }
        }
        if (changed) {
          touch()
        }
      }
      return true
    },
    has(_t, key) {
      return (typeof key === 'string' && byName.has(key)) || key in extra
    },
    ownKeys() {
      return [...byName.keys(), ...Reflect.ownKeys(extra)]
    },
    getOwnPropertyDescriptor(_t, key) {
      if (typeof key === 'string' && byName.has(key)) {
        return {
          enumerable: true,
          configurable: true,
          writable: true,
          value: block.values[key as keyof S]
        }
      }
      return key in extra
        ? {
            enumerable: true,
            configurable: true,
            writable: true,
            value: extra[key]
          }
        : undefined
    }
  })
  return block
}
