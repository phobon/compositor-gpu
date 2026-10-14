// Record of the equivalence check (cloud container, 2026-10-14; the paths
// are that container's). `__walk.ts` was src/gpu/cull.ts at HEAD (walk of
// every instance); the script compares its runs with the indexed
// cullRuns on random scenes, waiting after each scene's first query so
// the idle index is built and used. Run: npx tsx equivalence-check.mts
import { cullRuns as idx } from '/home/claude/cg2/src/gpu/cull.ts'
import { cullRuns as walk } from '/home/claude/cg2/src/gpu/__walk.ts'
let seed = 1
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
let fails = 0, checks = 0
for (let t = 0; t < 60; t++) {
  const H = 500 + rnd() * 60000
  const rect = () => {
    const tall = rnd() < 0.05
    return { x: rnd() * 1400 - 100, y: rnd() * H - 200, width: rnd() * 300, height: tall ? rnd() * H : rnd() * 60 }
  }
  const mk = (n: number) => Array.from({ length: n }, () => ({ rect: rect(), space: rnd() < 0.03 ? 'viewport' : undefined, batchRect: rnd() < 0.2 ? rect() : undefined }))
  const boxes = mk(Math.floor(rnd() * 400))
  const images = mk(Math.floor(rnd() * 50))
  const cutouts = mk(Math.floor(rnd() * 10))
  const runs = Array.from({ length: Math.floor(rnd() * 80) }, () => ({
    space: rnd() < 0.03 ? 'viewport' : undefined,
    textShadows: rnd() < 0.1 ? [{ ox: 2, oy: 3, blur: 4 }] : undefined,
    glyphs: Array.from({ length: Math.floor(rnd() * 60) }, () => ({ rect: rect(), xform: [1, rnd() < 0.1 ? 0.2 : 0, 0, 1, 0, 0], fontSize: 16 }))
  }))
  const nGlyph = runs.reduce((a, r) => a + r.glyphs.length, 0)
  const scene: any = { boxes, images, cutouts, runs }
  const batches: any[] = []
  const lens: Record<string, number> = { boxes: boxes.length, images: images.length, cutouts: cutouts.length, text: nGlyph }
  for (const layer of Object.keys(lens)) {
    let i = 0
    while (i < lens[layer]!) {
      const c = Math.min(lens[layer]! - i, 1 + Math.floor(rnd() * 300))
      batches.push({ kind: rnd() < 0.5 ? undefined : 'draw', layer, first: i, count: c, material: rnd() < 0.05 ? 7 : undefined })
      i += c
    }
    if (rnd() < 0.3) batches.push({ kind: 'push', group: 0 })
  }
  batches.sort(() => rnd() - 0.5)
  for (let q = 0; q < 10; q++) {
    const y = rnd() * H - 1000
    const region = [rnd() * -200, y, 1280 + rnd() * 200, y + rnd() * 3000] as const
    const keep = (m: number) => m === 7 && q % 2 === 0
    const a = JSON.stringify(idx(scene, batches, region, keep))
    const b = JSON.stringify(walk(scene, batches, region, keep))
    checks++
    if (q === 0) await new Promise((r) => setTimeout(r, 520))
    if (a !== b) { fails++; if (fails < 3) console.log('DIFF', t, q) }
  }
}
console.log(`checks ${checks}, mismatches ${fails}`)
