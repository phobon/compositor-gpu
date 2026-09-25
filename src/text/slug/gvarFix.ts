import * as opentype from 'opentype.js'

// opentype.js 2.0 reads a packed point-number count of 0 as "no points"
// where the gvar spec means "all points of the glyph" (OpenType, gvar,
// "Packed point numbers"). A tuple that carries private point numbers with
// count 0 therefore falls back to the glyph's *shared* point list: only that
// many deltas are parsed (the y deltas start mid-way through the x data) and
// they land on the shared points. Any glyph mixing a shared point list with
// an all-points tuple — Inter's D, R, ... — comes out mangled at every
// non-default weight.
//
// Fix without forking: an all-points count becomes an explicit, lazily
// materialised [0 .. pointCount + 3] (the 4 phantom points included), so both
// the delta count and the per-point application see every point. The list is
// lazy because the parser runs before glyphs are parsed and the point count
// forces `glyph.path`.

interface ParserLike {
  parseTupleVariationStore(
    tableOffset: number,
    axisCount: number,
    flavor: string,
    glyphs: { get(i: number): { path: unknown; points: unknown[] } },
    glyphIndex: number
  ): unknown
  parsePackedPointNumbers(): number[]
}

type Patched = ParserLike & {
  __gvarGlyph?: { path: unknown; points: unknown[] } | null
}

const PATCHED = Symbol.for('compositor-gpu.gvarFix')

function allPointsLazy(glyph: { path: unknown; points: unknown[] }): number[] {
  const target: number[] = []
  let filled = false
  const fill = () => {
    if (filled) {
      return
    }
    filled = true
    void glyph.path // forces the glyph parse that populates `points`
    const n = glyph.points.length + 4
    for (let i = 0; i < n; i++) {
      target.push(i)
    }
  }
  return new Proxy(target, {
    get(t, prop, recv) {
      fill()
      return Reflect.get(t, prop, recv)
    },
    has(t, prop) {
      fill()
      return Reflect.has(t, prop)
    },
    ownKeys(t) {
      fill()
      return Reflect.ownKeys(t)
    }
  })
}

/** Idempotent; runs once per opentype.js module instance. */
export function installGvarFix(): void {
  // ESM build exposes `_parse` as a named export; the CJS build (node, tsx)
  // hangs the same object off `default`.
  type Mod = {
    _parse?: { Parser?: { prototype: ParserLike & Record<symbol, boolean> } }
    default?: Mod
  }
  const mod = opentype as unknown as Mod
  const parser = (mod._parse ?? mod.default?._parse)?.Parser
  if (!parser) {
    return
  }
  const proto = parser.prototype
  if (proto[PATCHED]) {
    return
  }
  proto[PATCHED] = true

  const origStore = proto.parseTupleVariationStore
  const origPoints = proto.parsePackedPointNumbers

  proto.parseTupleVariationStore = function (
    this: Patched,
    tableOffset,
    axisCount,
    flavor,
    glyphs,
    glyphIndex
  ) {
    this.__gvarGlyph = flavor === 'gvar' ? glyphs.get(glyphIndex) : null
    try {
      return origStore.call(
        this,
        tableOffset,
        axisCount,
        flavor,
        glyphs,
        glyphIndex
      )
    } finally {
      this.__gvarGlyph = null
    }
  }

  proto.parsePackedPointNumbers = function (this: Patched) {
    const points = origPoints.call(this)
    const glyph = this.__gvarGlyph
    return points.length === 0 && glyph ? allPointsLazy(glyph) : points
  }
}
