// Hand-built element trees and records for unit tests (src/dom/tree.ts
// ElNode, src/scene/records.ts): just the fields the scene, scene_sync and
// the culler read.
import type { ElKid, ElNode } from '../../src/dom/tree'
import type { BoxRecord, GlyphRun, Rect } from '../../src/scene/records'

export function rect(
  x: number,
  y: number,
  width: number,
  height: number
): Rect {
  return { x, y, width, height }
}

export function box(
  id: number,
  r: Rect,
  over: Partial<BoxRecord> = {}
): BoxRecord {
  return {
    kind: 'box',
    id,
    z: 0,
    rect: r,
    xform: [1, 0, 0, 1, r.x, r.y],
    local: { width: r.width, height: r.height },
    radius: [0, 0, 0, 0],
    fill: [1, 1, 1, 1],
    opacity: 1,
    clip: null,
    ...over
  } as unknown as BoxRecord
}

export function run(id: number, x: number, y: number, n: number): GlyphRun {
  const glyphs = Array.from({ length: n }, (_, i) => {
    const r = rect(x + i * 10, y, 10, 16)
    return {
      index: i,
      rect: r,
      xform: [1, 0, 0, 1, r.x, r.y],
      local: { width: 10, height: 16 },
      glyphId: 97,
      text: 'a',
      colour: false,
      codePoints: 1,
      fontId: 0,
      fontSize: 16,
      color: [0, 0, 0, 1],
      offset: { x: 0, y: 0 }
    }
  })
  return {
    kind: 'text',
    id,
    z: 0,
    fontId: 0,
    fontFamily: 'Test',
    fontStack: 'Test',
    fontWeight: 400,
    opsz: null,
    italic: false,
    ligatures: false,
    color: [0, 0, 0, 1],
    glyphs,
    opacity: 1,
    clip: null
  } as unknown as GlyphRun
}

export function el(
  own: ElNode['own'],
  kids: ElKid[],
  over: Partial<ElNode> = {}
): ElNode {
  const n = {
    kind: 'element',
    el: {} as Element,
    parent: null,
    kids,
    rect: rect(0, 0, 1000, 1000),
    space: 'doc',
    trapsFixed: false,
    own,
    isContext: false,
    realContext: false,
    ctxZ: 0,
    childClip: null,
    alpha: 1,
    fragmented: false,
    float: false,
    lin: null,
    decor: null,
    cb: {},
    ...over
  } as unknown as ElNode
  for (const k of kids) {
    if (k.kind === 'element') {
      k.parent = n
    }
  }
  return n
}

/** An opacity group context. */
export function group(
  alpha: number,
  own: ElNode['own'],
  kids: ElKid[]
): ElNode {
  return el(own, kids, { isContext: true, realContext: true, alpha })
}
