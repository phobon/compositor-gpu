// Baked svg files (tools/bake_svg.ts, src/assets/vector_file.ts,
// src/paths/path_data.ts): a tape replays the exact sink calls parsing
// made, the static style cascade resolves what the DOM would, and what
// the runtime can't draw fails the file.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeBakedSvg,
  encodeBakedSvg,
  viewBoxMap
} from '../../src/assets/vector_file'
import {
  flattenPathData,
  type PathSink,
  replayTape,
  TapeSink
} from '../../src/paths/path_data'
import { BakeSvgError, bakeSvg, parseSvgTransform } from '../../tools/bake_svg'
import { parseXml } from '../../tools/xml'

/** Records every call as a string. */
class Calls implements PathSink {
  log: string[] = []
  moveTo(...a: number[]): void {
    this.log.push(`M${a}`)
  }
  lineTo(...a: number[]): void {
    this.log.push(`L${a}`)
  }
  quadTo(...a: number[]): void {
    this.log.push(`Q${a}`)
  }
  cubicTo(...a: number[]): void {
    this.log.push(`C${a}`)
  }
  arc(...a: number[]): void {
    this.log.push(`A${a}`)
  }
  end(closed: boolean): void {
    this.log.push(`E${closed}`)
  }
}

const D =
  'M3 4h5v2l-1 1c1 2 3 3 4 1s2-3 1-4q2 1 3 0t2 2a4 3 30 1 0 3 3zM10 10 12 12 14 10z'

test('a tape replays the calls parsing made, exactly', () => {
  const direct = new Calls()
  flattenPathData(D, direct)
  const tape = new TapeSink()
  flattenPathData(D, tape)
  const replayed = new Calls()
  replayTape(Float64Array.from(tape.ops), replayed)
  assert.deepEqual(replayed.log, direct.log)
  assert.ok(direct.log.some((c) => c.startsWith('A')))
})

test('svg transforms compose left to right', () => {
  const m = parseSvgTransform('translate(10 20) scale(2) rotate(90)')
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12)
  ;[0, 2, -2, 0, 10, 20].forEach((v, k) => {
    close(m[k] ?? Number.NaN, v)
  })
  assert.throws(() => parseSvgTransform('translate(1 2) bogus'), BakeSvgError)
})

test('paint cascades: attributes, style, inheritance, <use>, currentColor', () => {
  const svg =
    bakeSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"
      fill="red" color="#123456">
    <defs><circle id="c" r="1"/></defs>
    <g stroke="blue" style="stroke-width: 3px" transform="translate(1 2)">
      <rect width="4" height="4" fill="currentColor"/>
      <use href="#c" x="5" y="6" fill="green"/>
      <path d="M0 0L1 1" style="fill: none; stroke: inherit" stroke-linecap="round"/>
    </g>
    <line x1="0" y1="0" x2="1" y2="1" display="none"/>
  </svg>`)
  assert.deepEqual(svg.viewBox, [0, 0, 10, 10])
  assert.equal(svg.align, 'xMidYMid')
  const [rect, use, path] = svg.shapes
  assert.equal(svg.shapes.length, 3)
  assert.equal(rect?.fill, '#123456')
  assert.equal(rect?.stroke, 'blue')
  assert.equal(rect?.strokeWidth, 3)
  assert.deepEqual(rect?.m, [1, 0, 0, 1, 1, 2])
  // The used circle inherits from the <use>, offset by its x / y.
  assert.equal(use?.fill, 'green')
  assert.deepEqual(use?.m, [1, 0, 0, 1, 6, 8])
  assert.equal(path?.fill, 'none')
  assert.equal(path?.stroke, 'blue')
  assert.equal(path?.cap, 1)
})

test('what the path pass cannot draw fails the file', () => {
  const wrap = (body: string, attrs = '') =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"${attrs}>${body}</svg>`
  for (const [body, why] of [
    ['<rect width="1" height="1" fill="url(#g)"/>', /fill url/],
    [
      '<style>rect { fill: red }</style><rect width="1" height="1"/>',
      /<style>/
    ],
    ['<rect width="50%" height="1"/>', /only plain numbers/],
    ['<g opacity="0.5"><rect width="1" height="1"/></g>', /group opacity/],
    ['<text>hi</text>', /<text>/],
    ['<path d="M0 0L1 1" stroke="red" stroke-dasharray="2"/>', /dasharray/],
    ['<use href="#nope"/>', /use href/]
  ] as const) {
    assert.throws(() => bakeSvg(wrap(body)), why)
  }
  assert.throws(
    () => bakeSvg('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    /no viewBox/
  )
})

test('a baked file round-trips', () => {
  const svg =
    bakeSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12"
      preserveAspectRatio="xMaxYMin slice"><path d="${D}" fill-opacity=".5"/></svg>`)
  const back = decodeBakedSvg(encodeBakedSvg(svg))
  assert.deepEqual(back.viewBox, [0, 0, 24, 12])
  assert.equal(back.align, 'xMaxYMin')
  assert.equal(back.slice, true)
  assert.deepEqual(back.shapes, svg.shapes)
  assert.deepEqual([...back.tape], [...svg.tape])
  assert.equal(back.shapes[0]?.fillOpacity, 0.5)
})

test('viewBox maps per preserveAspectRatio', () => {
  const h = {
    shapes: [],
    viewBox: [0, 0, 20, 10] as [number, number, number, number]
  }
  assert.deepEqual(
    viewBoxMap({ ...h, align: 'none', slice: false }, 40, 40),
    [2, 0, 0, 4, 0, 0]
  )
  // meet: scale 2, centred vertically.
  assert.deepEqual(
    viewBoxMap({ ...h, align: 'xMidYMid', slice: false }, 40, 40),
    [2, 0, 0, 2, 0, 10]
  )
  assert.deepEqual(
    viewBoxMap({ ...h, align: 'xMinYMax', slice: false }, 40, 40),
    [2, 0, 0, 2, 0, 20]
  )
  // slice that would crop: not drawn as vectors.
  assert.equal(
    viewBoxMap({ ...h, align: 'xMidYMid', slice: true }, 40, 40),
    null
  )
  assert.ok(viewBoxMap({ ...h, align: 'xMidYMid', slice: true }, 40, 20))
})

test('the xml reader: entities, CDATA, comments, prefixes', () => {
  const x = parseXml(`<?xml version="1.0"?>
    <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">
    <!-- c --><svg:svg xmlns:svg="s" a="1 &amp; &#x41;&#66;"><svg:g/><t><![CDATA[<x>]]> &lt;y&gt;</t></svg:svg>`)
  assert.equal(x.name, 'svg')
  assert.equal(x.attrs.get('a'), '1 & AB')
  assert.equal(x.children[0]?.name, 'g')
  assert.equal(x.children[1]?.text, '<x> <y>')
  assert.throws(() => parseXml('<a><b></a>'), /does not close/)
})
