// compositor-gpu bake (M5f; docs/EFFECTS.md, Bake CLI): turn fonts into
// GPU-ready files (src/text/slug/baked.ts), and svg files into vector
// files (src/assets/vector_file.ts), plus a manifest pages load with
// `createCompositor({ assets: '/gpu/manifest.json' })`. Effect-input
// images and distance-field masks follow.
//
//   npm run bake [-- path/to/compositor-gpu.bake.json]
//
// The config (default ./compositor-gpu.bake.json):
//
//   {
//     "out": "public/gpu",                 // manifest.json + files go here
//     "fonts": [{
//       "file": "fonts/InterVariable.ttf", // ttf / otf (not woff2)
//       "family": "Inter",                 // the CSS family pages use
//       "weights": [400, 700],             // variable: instances; static:
//                                          //   its one weight (default 400)
//       "italic": false,
//       "opsz": [14, 32],                  // fonts with an opsz axis: the
//                                          //   optical sizes to bake (a
//                                          //   run uses a face only at its
//                                          //   own, else the runtime path)
//       "unicodeRange": "U+0020-007E, U+00A0-00FF"
//     }],
//     "svgs": [                            // <img data-gpu-vector> files
//       { "dir": "public/icons", "src": "/icons/" },  // every *.svg in it
//       { "file": "art/logo.svg", "src": "/logo.svg" }
//     ]
//   }
//
// `src` is the URL pages load the file from (an img's src, from the
// site's root); the runtime matches imgs by it. An svg using something
// the path pass can't draw is skipped with the reason (pages draw it as
// an image, as before).
//
// Each (weight, opsz) is one file; the outlines come from the same code
// the runtime parses fonts with (src/text/slug/font.ts), so a baked face
// draws exactly as the parsed one.
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BakedManifest, BakedSvgEntry } from '../src/assets/manifest'
import { encodeBakedSvg } from '../src/assets/vector_file'
import { type BakedFace, encodeBakedFont } from '../src/text/slug/baked'
import {
  type FontHandle,
  type Ligature,
  loadFontFile,
  loadParser,
  makeInstance
} from '../src/text/slug/font'
import { BakeSvgError, bakeSvg } from './bake_svg'

interface FontConfig {
  file: string
  family: string
  weights?: number[]
  weight?: number
  italic?: boolean
  opsz?: number[]
  unicodeRange?: string
}

type SvgConfig = { dir: string; src: string } | { file: string; src: string }

interface Config {
  out: string
  fonts?: FontConfig[]
  svgs?: SvgConfig[]
}

/** The svg files a config lists, with the URLs pages use for them. */
function svgFiles(root: string, list: SvgConfig[]): [string, string][] {
  const out: [string, string][] = []
  for (const c of list) {
    if ('dir' in c) {
      const dir = resolve(root, c.dir)
      const base = c.src.endsWith('/') ? c.src : `${c.src}/`
      for (const f of readdirSync(dir).sort()) {
        if (f.toLowerCase().endsWith('.svg')) {
          out.push([join(dir, f), base + f])
        }
      }
    } else {
      out.push([resolve(root, c.file), c.src])
    }
  }
  return out
}

/** CSS unicode-range ("U+0020-007E, U+00??, U+20AC") as [lo, hi] pairs. */
export function parseUnicodeRange(s: string): [number, number][] {
  const out: [number, number][] = []
  for (const part of s.split(',')) {
    const t = part.trim().toUpperCase().replace(/^U\+/, '')
    if (!t) {
      continue
    }
    if (t.includes('?')) {
      out.push([
        Number.parseInt(t.replace(/\?/g, '0'), 16),
        Number.parseInt(t.replace(/\?/g, 'F'), 16)
      ])
    } else if (t.includes('-')) {
      const [a = '0', b = '0'] = t.split('-')
      out.push([Number.parseInt(a, 16), Number.parseInt(b, 16)])
    } else {
      const v = Number.parseInt(t, 16)
      out.push([v, v])
    }
  }
  return out.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

export function bakeInstance(
  handle: FontHandle,
  ranges: [number, number][],
  coords: Record<string, number> | undefined
): { bytes: ArrayBuffer; glyphs: number } {
  const inst = makeInstance(handle, 0, coords)
  // Codepoints the font maps inside the ranges.
  const map = (
    handle.font.tables as unknown as {
      cmap: { glyphIndexMap: Record<string, number> }
    }
  ).cmap.glyphIndexMap
  const cmap = new Map<number, number>()
  for (const key of Object.keys(map)) {
    const cp = Number(key)
    if (ranges.some(([a, b]) => cp >= a && cp <= b)) {
      const g = inst.glyphForCodePoint(cp)
      if (g !== 0) {
        cmap.set(cp, g)
      }
    }
  }
  // Glyphs: .notdef, the mapped ones, and ligatures whose components are
  // all baked (repeated: a ligature can feed a longer one's components).
  const glyphs = new Set<number>([0, ...cmap.values()])
  const ligatures: Ligature[] = []
  const all = [...handle.ligatures.values()].flat()
  const taken = new Set<Ligature>()
  for (let changed = true; changed; ) {
    changed = false
    for (const l of all) {
      if (!taken.has(l) && l.seq.every((g) => glyphs.has(g))) {
        taken.add(l)
        ligatures.push(l)
        glyphs.add(l.by)
        changed = true
      }
    }
  }
  const bytes = encodeBakedFont({
    unitsPerEm: inst.unitsPerEm,
    ascender: inst.ascender,
    descender: inst.descender,
    cmap,
    ligatures,
    glyphs: [...glyphs],
    glyph: (i) => inst.glyph(i)
  })
  return { bytes, glyphs: glyphs.size }
}

/** Bake everything `configPath` lists; returns the manifest written. */
export async function bake(
  configPath: string,
  quiet = false
): Promise<BakedManifest> {
  const say = quiet ? () => {} : (s: string) => console.log(s)
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Config
  const root = dirname(configPath)
  const out = resolve(root, config.out)
  mkdirSync(out, { recursive: true })
  await loadParser()
  const manifest: BakedManifest = { version: 1, fonts: [], svgs: [] }
  const fonts = manifest.fonts as BakedFace[]
  const svgs = manifest.svgs as BakedSvgEntry[]
  if ((config.fonts ?? []).length > 0) {
    say(
      '[bake] note: some font licences forbid converting the font into another format; check yours before shipping baked files.'
    )
  }
  for (const f of config.fonts ?? []) {
    const file = resolve(root, f.file)
    const buf = readFileSync(file)
    const handle = loadFontFile(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    )
    const rangeText = f.unicodeRange ?? 'U+0000-10FFFF'
    const ranges = parseUnicodeRange(rangeText)
    const italic = f.italic ?? false
    const wght = handle.wght
    const weights = wght
      ? (f.weights ?? [wght.def])
      : [f.weight ?? f.weights?.[0] ?? 400]
    const opszAxis = handle.opsz
    if (opszAxis && !f.opsz) {
      console.warn(
        `[bake] ${basename(file)} has an opsz axis (${opszAxis.min}-${opszAxis.max}) and no "opsz" listed: baking ${opszAxis.def} only (runs at other optical sizes use the runtime path)`
      )
    }
    const sizes: (number | null)[] = opszAxis
      ? (f.opsz ?? [opszAxis.def]).map((o) =>
          Math.max(opszAxis.min, Math.min(opszAxis.max, Math.round(o)))
        )
      : [null]
    for (const weight of weights) {
      for (const opsz of [...new Set(sizes)]) {
        const w = wght ? Math.max(wght.min, Math.min(wght.max, weight)) : weight
        const coords =
          wght || opszAxis
            ? {
                ...(wght ? { wght: w } : {}),
                ...(opsz !== null ? { opsz } : {})
              }
            : undefined
        const { bytes, glyphs } = bakeInstance(handle, ranges, coords)
        const name = `${slug(f.family)}-${w}${italic ? 'i' : ''}${
          opsz === null ? '' : `-o${opsz}`
        }.cgf`
        writeFileSync(resolve(out, name), new Uint8Array(bytes))
        const face: BakedFace = {
          family: f.family,
          weight: w,
          italic,
          opsz,
          opszRange: opszAxis ? [opszAxis.min, opszAxis.max] : null,
          opszDefault: opszAxis ? opszAxis.def : null,
          wghtRange: wght ? [wght.min, wght.max] : null,
          url: name,
          glyphs,
          bytes: bytes.byteLength,
          unicodeRange: rangeText
        }
        fonts.push(face)
        say(
          `[bake] ${name}: ${glyphs} glyphs, ${(bytes.byteLength / 1024).toFixed(1)} KB`
        )
      }
    }
  }
  if ((config.svgs ?? []).length > 0) {
    mkdirSync(resolve(out, 'svg'), { recursive: true })
  }
  const names = new Set<string>()
  for (const [file, src] of svgFiles(root, config.svgs ?? [])) {
    let bytes: ArrayBuffer
    let shapes: number
    try {
      const svg = bakeSvg(readFileSync(file, 'utf8'), basename(file))
      bytes = encodeBakedSvg(svg)
      shapes = svg.shapes.length
    } catch (err) {
      if (err instanceof BakeSvgError) {
        console.warn(`[bake] skipped ${src}: ${err.message}`)
        continue
      }
      throw err
    }
    let name = `svg/${slug(basename(file, '.svg'))}.cgv`
    for (let k = 2; names.has(name); k++) {
      name = `svg/${slug(basename(file, '.svg'))}-${k}.cgv`
    }
    names.add(name)
    writeFileSync(resolve(out, name), new Uint8Array(bytes))
    svgs.push({ src, url: name, shapes, bytes: bytes.byteLength })
  }
  if (svgs.length) {
    const kb = svgs.reduce((n, f) => n + f.bytes, 0) / 1024
    say(`[bake] ${svgs.length} svg file(s), ${kb.toFixed(1)} KB`)
  }
  const mpath = resolve(out, 'manifest.json')
  writeFileSync(mpath, `${JSON.stringify(manifest, null, 2)}\n`)
  const total = fonts.reduce((n, f) => n + f.bytes, 0)
  say(
    `[bake] ${mpath}: ${fonts.length} font file(s), ${(total / 1024).toFixed(1)} KB (sources ${(
      (config.fonts ?? []).reduce(
        (n, f) => n + statSync(resolve(root, f.file)).size,
        0
      ) / 1024
    ).toFixed(1)} KB)`
  )
  return manifest
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await bake(resolve(process.argv[2] ?? 'compositor-gpu.bake.json'))
}
