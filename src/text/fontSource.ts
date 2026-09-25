import { log } from '../util/log'

/** Bytes for one face plus the descriptor used for per-run resolution. */
export interface ResolvedFont {
  buffer: ArrayBuffer
  descriptor: { family: string; weight: number; italic: boolean }
}

interface SrcRef {
  url: string
  format: string
}

interface FaceRule {
  family: string // lowercased, unquoted
  weight: number
  italic: boolean
  srcs: SrcRef[]
}

const numWeight = (w: string): number => {
  const s = w.trim().toLowerCase()
  if (s === '' || s === 'normal') {
    return 400
  }
  if (s === 'bold') {
    return 700
  }
  // Variable ranges ("100 900") resolve to their lower bound.
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : 400
}

const isItalic = (style: string): boolean => {
  const s = style.trim().toLowerCase()
  return s === 'italic' || s.startsWith('oblique')
}

const unquote = (s: string): string => s.trim().replace(/^['"]|['"]$/g, '')

/** Parse a `src:` value into url() refs, dropping local() and bad urls. */
function parseSrcUrls(src: string, baseHref: string | null): SrcRef[] {
  const out: SrcRef[] = []
  const re =
    /url\(\s*(['"]?)([^'")]+)\1\s*\)(?:\s*format\(\s*(['"]?)([^'")]+)\3\s*\))?/g
  const base = baseHref ?? document.baseURI
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const raw = m[2]
    if (!raw) {
      continue
    }
    let url: string
    try {
      url = new URL(raw, base).href
    } catch {
      continue
    }
    out.push({ url, format: (m[4] ?? '').toLowerCase() })
  }
  return out
}

/** Read every @font-face rule reachable from the document's stylesheets. */
function collectFaceRules(): FaceRule[] {
  const out: FaceRule[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules // throws on cross-origin sheets
    } catch {
      continue
    }
    for (const rule of Array.from(rules)) {
      if (rule.type !== CSSRule.FONT_FACE_RULE) {
        continue
      }
      const st = (rule as CSSFontFaceRule).style
      const family = unquote(st.getPropertyValue('font-family')).toLowerCase()
      if (!family) {
        continue
      }
      const srcs = parseSrcUrls(st.getPropertyValue('src'), sheet.href)
      if (srcs.length === 0) {
        continue
      }
      out.push({
        family,
        weight: numWeight(st.getPropertyValue('font-weight')),
        italic: isItalic(st.getPropertyValue('font-style')),
        srcs
      })
    }
  }
  return out
}

const formatOf = (s: SrcRef): string => {
  if (s.format) {
    return s.format
  }
  const ext = s.url.split(/[?#]/)[0]?.split('.').pop()?.toLowerCase() ?? ''
  return ext
}

/** opentype.js parses ttf/otf/woff but not woff2, so rank woff2 last. */
const srcRank = (s: SrcRef): number => {
  const f = formatOf(s)
  if (f.includes('woff2')) {
    return 3
  }
  if (f.includes('truetype') || f.includes('opentype')) {
    return 0
  }
  if (f === 'ttf' || f === 'otf') {
    return 0
  }
  if (f.includes('woff')) {
    return 1
  }
  return 2
}

const pickUrl = (srcs: SrcRef[]): string | null =>
  [...srcs].sort((a, b) => srcRank(a) - srcRank(b))[0]?.url ?? null

/** Best rule for a face: family + italic, then exact then nearest weight. */
function matchUrl(
  rules: FaceRule[],
  family: string,
  weight: number,
  italic: boolean
): string | null {
  let pool = rules.filter((r) => r.family === family)
  if (pool.length === 0) {
    return null
  }
  const italicPool = pool.filter((r) => r.italic === italic)
  if (italicPool.length > 0) {
    pool = italicPool
  }
  let best = pool[0] ?? null
  let bestDiff = best
    ? Math.abs(best.weight - weight)
    : Number.POSITIVE_INFINITY
  for (const r of pool) {
    const d = Math.abs(r.weight - weight)
    if (d < bestDiff) {
      best = r
      bestDiff = d
    }
  }
  return best ? pickUrl(best.srcs) : null
}

async function fetchBuffer(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) {
      log.info(`font fetch ${res.status}: ${url}`)
      return null
    }
    return await res.arrayBuffer()
  } catch {
    log.info(`font fetch failed: ${url}`)
    return null
  }
}

/** `resolveFontBytes` result: bytes resolved plus faces that couldn't be —
 * no matching @font-face src, or its url() didn't fetch. */
export interface ResolveResult {
  resolved: ResolvedFont[]
  /** `"family weight[i]"` labels of faces that failed to resolve. */
  failed: string[]
}

const faceLabel = (family: string, weight: number, italic: boolean): string =>
  `${family} ${weight}${italic ? 'i' : ''}`

/**
 * Resolve FontFace objects to their raw bytes at runtime.
 *
 * A FontFace does not expose its parsed bytes or its source URL, so we match
 * each face (by family, style and nearest weight) to an @font-face rule in the
 * page's stylesheets and fetch that rule's url() source. Faces with no matching
 * rule (system fonts, bytes-backed FontFaces) are skipped — the caller's
 * nearest-weight fallback still covers runs that use them.
 */
export async function resolveFontBytes(
  faces: FontFace[]
): Promise<ResolveResult> {
  if (faces.length === 0) {
    return { resolved: [], failed: [] }
  }
  const rules = collectFaceRules()
  const seen = new Set<string>()
  const bufByUrl = new Map<string, Promise<ArrayBuffer | null>>()
  const resolved: ResolvedFont[] = []
  const failed: string[] = []

  for (const face of faces) {
    const family = unquote(face.family).toLowerCase()
    const weight = numWeight(face.weight)
    const italic = isItalic(face.style)
    const key = `${family}|${weight}|${italic ? 1 : 0}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)

    const url = matchUrl(rules, family, weight, italic)
    if (!url) {
      log.info(
        `font: no @font-face src for ${family} ${weight}${italic ? 'i' : ''}`
      )
      failed.push(faceLabel(family, weight, italic))
      continue
    }
    let bufP = bufByUrl.get(url)
    if (!bufP) {
      bufP = fetchBuffer(url)
      bufByUrl.set(url, bufP)
    }
    const buffer = await bufP
    if (!buffer) {
      failed.push(faceLabel(family, weight, italic))
      continue
    }
    resolved.push({
      buffer,
      descriptor: { family: face.family, weight, italic }
    })
  }
  return { resolved, failed }
}
