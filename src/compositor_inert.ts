import type { Profile } from './profile/profiler'
import type { Compositor } from './types'

// The compositor without WebGPU: every call works, nothing renders, the
// page is untouched. Its own module so the entry (create.ts) can return it
// without loading the renderer.

const inertProfile: Profile = {
  start() {},
  stop: () => Promise.resolve(null),
  mark() {},
  recording: false,
  hud: () => false,
  recent: () => [],
  flight() {},
  flying: false,
  save: () => Promise.resolve(null),
  element: () => null,
  tracks() {},
  tracking: false
}

export function inert(): Compositor & { text: null; scene: null } {
  return {
    active: false,
    canvas: null,
    text: null,
    scene: null,
    graph: null,
    profile: inertProfile,
    stats: () => ({
      active: false,
      boxes: 0,
      images: 0,
      glyphs: 0,
      cutouts: 0,
      paths: 0,
      fallback: 0,
      fallbackSamples: [],
      ligatures: 0,
      faces: 0,
      uploads: 0,
      batches: 0,
      draws: 0,
      instances: 0,
      fillRows: 0,
      pendingRows: 0,
      skippedFrames: 0,
      groups: 0,
      groupPasses: 0,
      sceneReused: false,
      readElements: 0,
      partialReads: 0,
      patchedReads: 0,
      refits: 0,
      sync: {
        layout: 0,
        style: 0,
        content: 0,
        mutation: 0,
        animating: 0,
        last: ''
      },
      textRead: { graphemes: 0, perGrapheme: 0, ranges: 0 },
      readMs: 0,
      uploadMs: 0,
      encodeMs: 0,
      cullMs: 0,
      fps: 0,
      frameMs: 0,
      maxDtMs: 0,
      scrolling: false,
      anchorX: 0,
      anchorY: 0,
      reanchors: 0
    }),
    start() {},
    stop() {},
    ready: Promise.resolve(),
    sceneReuse: false,
    skeleton: false,
    invalidate() {},
    setSourceHidden() {},
    destroy() {}
  }
}
