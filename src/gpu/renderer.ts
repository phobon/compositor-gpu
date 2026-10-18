import type { DrawBatch } from '../scene/batches'
import type { DropShadow } from '../scene/filter'
import type { BackdropRecord, Rect } from '../scene/records'
import type { Scene } from '../scene/scene'
import type { OpacityGroup } from '../scene/stacking'
import type { FrameContext, Layer } from '../types'
import { BackdropPass } from './backdrop'
import { GroupCompositor, type GroupTarget, rectQuad } from './composite'
import { cullRuns, type Region, type Runs, updateBounds } from './cull'
import type { GpuContext } from './device'
import {
  CLIP_FLOATS,
  FRAME_BYTES,
  MAX_CLIP_SHAPES,
  type RenderPass,
  type Shared
} from './frame'
import {
  ClearRect,
  CopyThrough,
  type DeviceRect,
  type ExtraLayer,
  type LayerTransform,
  type MaterialEntry,
  type PostChain,
  type PostFrame,
  type RegionFrame,
  type RegionHandler
} from './graph'
import { GroupBlur } from './group_blur'
import { materialPipelinesSettled } from './material'
import { type GpuFrameTiming, GpuTimer, timed } from './timer'

interface FrameSlot {
  buffer: GPUBuffer
  bindGroup: GPUBindGroup
}

/** A render target on the group stack (the canvas, or a group texture). */
interface Target {
  view: GPUTextureView
  /** Bind group 0 whose Frame maps doc space onto this target. */
  bindGroup: GPUBindGroup
  /** Doc-space position of the target's top-left pixel. */
  ox: number
  oy: number
  /** Size in device px. */
  devW: number
  devH: number
  /** Device px per CSS px. */
  sx: number
  sy: number
  /** Scene.groups index; -1 for the canvas. */
  group: number
  /** The pooled texture; null for the canvas. */
  pooled: GroupTarget | null
  /** Doc-space rect (minX, minY, maxX, maxY) to composite onto the parent,
   * and the used region's size in device px. */
  rect: [number, number, number, number]
  w: number
  h: number
  /** Top-left of the used region in the parent target's device px. */
  px: number
  py: number
  /** A layer transform's doc-space affine (null: composite in place). */
  xf: Affine | null
  /** Set when a region handler composites it (encoded in prepare). */
  region?: RegionFrame
  /** Device-px rect (x, y, w, h) its passes draw within; absent: all of
   * it (CompositorOptions.canvasFill: the main target's visible band; a
   * group in a group atlas: its rect). */
  scissor?: [number, number, number, number]
  /** In a group atlas: the device px of `pooled` where this group's
   * texture starts (absent: 0, 0). */
  uv0?: [number, number]
}

/** A group deferred to a parent's group atlas (Renderer.render): its
 * push and pop batch indices, Scene.groups index and placement. */
interface Leaf {
  i: number
  j: number
  group: number
  m: GroupPlace
}

/** Device px between rects in a group atlas (bilinear sampling at an edge
 * must not reach a neighbour). */
const ATLAS_GUTTER = 2
/** Smallest strip of a re-anchor's pending rows drawn per frame, CSS px
 * (Renderer.reanchorStrips). */
const STRIP_MIN = 96

/** A group's texture placement before a texture is chosen (see
 * Renderer.measureGroup). */
interface GroupPlace {
  /** Texture size, device px. */
  w: number
  h: number
  /** Texture device px per CSS px. */
  sx: number
  sy: number
  /** Doc-space origin of the group's region. */
  ox: number
  oy: number
  /** Top-left in the parent's device px. */
  px: number
  py: number
  /** The transform's scale the texture renders at. */
  kx: number
  ky: number
  xf: Affine | null
}

/** The rows spanning two full-width device-px rects (x, y, w, h). */
function hullRows(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number]
): [number, number, number, number] {
  const y0 = Math.min(a[1], b[1])
  const y1 = Math.max(a[1] + a[3], b[1] + b[3])
  return [a[0], y0, Math.max(a[2], b[2]), y1 - y0]
}

/** Rows [y0, y1) not covered by `cover` (disjoint, in order). */
function rowsMissing(
  y0: number,
  y1: number,
  cover: readonly (readonly [number, number])[]
): [number, number][] {
  const out: [number, number][] = []
  let y = y0
  for (const [a, b] of cover) {
    if (b <= y) {
      continue
    }
    if (a >= y1) {
      break
    }
    if (a > y) {
      out.push([y, a])
    }
    y = Math.max(y, b)
    if (y >= y1) {
      break
    }
  }
  if (y < y1) {
    out.push([y, y1])
  }
  return out
}

/** `list` with [y0, y1) added, merged (disjoint, in order). */
function addRows(
  list: readonly (readonly [number, number])[],
  y0: number,
  y1: number
): [number, number][] {
  const all: [number, number][] = [
    ...list.map((r) => [r[0], r[1]] as [number, number]),
    [y0, y1]
  ]
  all.sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const iv of all) {
    const last = out[out.length - 1]
    if (last && iv[0] <= last[1]) {
      last[1] = Math.max(last[1], iv[1])
    } else if (iv[1] > iv[0]) {
      out.push(iv)
    }
  }
  return out
}

/** Intersection of two device-px rects (x, y, w, h); w or h 0 when they
 * don't meet. */
function meet(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number]
): [number, number, number, number] {
  const x = Math.max(a[0], b[0])
  const y = Math.max(a[1], b[1])
  const w = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - x)
  const h = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - y)
  return [x, y, w, h]
}

function clamp(v: number, max: number): number {
  return Math.min(Math.max(v, 0), max)
}

/** A doc-space affine [a, b, c, d, e, f]: (x, y) -> (a x + c y + e,
 * b x + d y + f). */
type Affine = readonly [number, number, number, number, number, number]

function apply(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

function invert(m: Affine): Affine | null {
  const det = m[0] * m[3] - m[1] * m[2]
  if (Math.abs(det) < 1e-9) {
    return null
  }
  const a = m[3] / det
  const b = -m[1] / det
  const c = -m[2] / det
  const d = m[0] / det
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])]
}

/** `t` as a doc-space affine about its origin in the group's box, or null
 * when it is the identity (or the group has no box). */
function layerAffine(
  g: OpacityGroup,
  t: LayerTransform,
  ctx: FrameContext
): Affine | null {
  const sx = Number.isFinite(t.scaleX) ? t.scaleX : 1
  const sy = Number.isFinite(t.scaleY) ? t.scaleY : 1
  const rot = Number.isFinite(t.rotate) ? t.rotate : 0
  const tx = Number.isFinite(t.x) ? t.x : 0
  const ty = Number.isFinite(t.y) ? t.y : 0
  if (tx === 0 && ty === 0 && sx === 1 && sy === 1 && rot % 360 === 0) {
    return null
  }
  const box = g.box
  if (!box) {
    return null
  }
  const vx = g.space === 'viewport' ? ctx.scrollX : 0
  const vy = g.space === 'viewport' ? ctx.scrollY : 0
  const ox =
    box.x + vx + (Number.isFinite(t.originX) ? t.originX : 0.5) * box.width
  const oy =
    box.y + vy + (Number.isFinite(t.originY) ? t.originY : 0.5) * box.height
  const r = (rot * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const a = cos * sx
  const b = sin * sx
  const c = -sin * sy
  const d = cos * sy
  return [a, b, c, d, ox + tx - (a * ox + c * oy), oy + ty - (b * ox + d * oy)]
}

type Box4 = [number, number, number, number]

/** Resolution bounds for a transformed group's texture, relative to its
 * parent's: rendered at the transform's own scale (as a browser
 * re-rasters a scaled layer), so text and edges stay crisp scaled down or
 * up and the composite samples about 1:1. */
const MIN_RES = 1 / 16
const MAX_RES = 4

/** `m`'s axis scales (the lengths the unit x and y axes map to), clamped
 * to [MIN_RES, MAX_RES]. */
function axisScales(m: Affine): [number, number] {
  const c = (v: number) => Math.min(MAX_RES, Math.max(MIN_RES, v))
  return [c(Math.hypot(m[0], m[1])), c(Math.hypot(m[2], m[3]))]
}

/** A layer transform's opacity in [0, 1] (1 when not a number). */
function layerAlpha(t: LayerTransform): number {
  return Number.isFinite(t.opacity) ? Math.min(1, Math.max(0, t.opacity)) : 1
}

/** `g`'s doc-space extent at the current scroll (viewport-space members
 * at their viewport rect + scroll), or null when empty. */
function groupExtent(g: OpacityGroup, ctx: FrameContext): Box4 | null {
  let bx0 = Number.POSITIVE_INFINITY
  let by0 = Number.POSITIVE_INFINITY
  let bx1 = Number.NEGATIVE_INFINITY
  let by1 = Number.NEGATIVE_INFINITY
  const d = g.bounds
  if (d.width > 0 && d.height > 0) {
    bx0 = d.x
    by0 = d.y
    bx1 = d.x + d.width
    by1 = d.y + d.height
  }
  const v = g.vbounds
  if (v) {
    bx0 = Math.min(bx0, v.x + ctx.scrollX)
    by0 = Math.min(by0, v.y + ctx.scrollY)
    bx1 = Math.max(bx1, v.x + v.width + ctx.scrollX)
    by1 = Math.max(by1, v.y + v.height + ctx.scrollY)
  }
  return bx1 > bx0 && by1 > by0 ? [bx0, by0, bx1, by1] : null
}

/** AABB of `m` applied to the rect (x0, y0)-(x1, y1). */
function mapRect(
  m: Affine,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): [number, number, number, number] {
  const p = [
    apply(m, x0, y0),
    apply(m, x1, y0),
    apply(m, x0, y1),
    apply(m, x1, y1)
  ]
  return [
    Math.min(...p.map((q) => q[0])),
    Math.min(...p.map((q) => q[1])),
    Math.max(...p.map((q) => q[0])),
    Math.max(...p.map((q) => q[1]))
  ]
}

/** Index of the pop matching the push of `group` at `i`. */
function skipGroup(
  list: readonly DrawBatch[],
  i: number,
  group: number
): number {
  for (let j = i + 1; j < list.length; j++) {
    const b = list[j]
    if (b && b.kind === 'pop' && b.group === group) {
      return j
    }
  }
  return list.length
}

/**
 * Owns the shared frame uniforms and drives the per-frame render: update
 * uniforms, (re-)upload dirty passes, walk the batch list (one render pass
 * per target segment; see render()), submit.
 */
export class Renderer {
  private readonly device: GPUDevice
  private readonly frameBuffer: GPUBuffer
  /** Clip shapes (frame.ts FrameClip), bound in every bind group 0. */
  private readonly clipBuffer: GPUBuffer
  private readonly clipData = new Float32Array(MAX_CLIP_SHAPES * CLIP_FLOATS)
  /** Scene.version the clip table was last uploaded for. */
  private clipVersion = -1
  /** The scene being rendered (for clip shape indices). */
  private scene: Scene | null = null
  readonly shared: Shared
  private readonly passes: RenderPass[] = []
  private readonly passByLayer = new Map<Layer, RenderPass>()
  private readonly frameData = new Float32Array(FRAME_BYTES / 4)
  /** Layers re-uploaded in the most recent render (for debug/stats). */
  lastUploads = 0
  /** Draw batches issued in the most recent render (for debug/stats). */
  lastBatches = 0
  /** Opacity groups composited in the most recent render. */
  lastGroups = 0
  /** `encoder.draw` calls issued by passes in the most recent render (for
   * debug/stats) — lower than `lastBatches` when a pass collapses several
   * instances into one draw (e.g. atlas-backed images). */
  lastDraws = 0
  /** The most recent render ran the post chain on the previous frame's
   * scene texture instead of redrawing the scene (see reuseKey). */
  lastReused = false
  /** CompositorOptions.sceneReuse. */
  reuseScene = true
  /** CompositorOptions.skipUnchanged: with canvasFill 'band', draw only
   * band rows not drawn since the content last changed, and skip frames
   * with nothing to draw. */
  skipUnchanged = true
  /** The most recent frame drew nothing (skipUnchanged). */
  lastSkipped = false
  /** Frames skipped since creation (stats().skippedFrames). */
  skippedFrames = 0
  /** The last presented frame came out of the post chain (the canvas then
   * differs from the kept texture, so a frame can't be skipped). */
  private presentedChain = false
  /** Wall time spent in pass uploads in the most recent render, ms. */
  lastUploadMs = 0
  /** Wall time from createCommandEncoder to submit in the most recent
   * render, ms. */
  lastEncodeMs = 0
  /** Upload wall time per layer in the most recent render, ms (layers
   * not re-uploaded are absent). */
  lastUploadByLayer: Partial<Record<Layer, number>> = {}
  /** Frames rendered (GpuFrameTiming.frame refers to it). */
  frames = 0
  private readonly composite: GroupCompositor
  /** CSS `filter: blur()` on groups (made on first use). */
  private groupBlur: GroupBlur | null = null
  /** CSS `backdrop-filter` draws (made on first use). */
  private backdrop: BackdropPass | null = null
  /** The canvas was configured with TEXTURE_BINDING (for backdrops). */
  private canvasSampled = false
  /** Skip instances outside the canvas region, or the band with
   * `canvasFill: 'band'` (CompositorOptions.cullDraws). */
  cullDraws: boolean | 'canvas' = true
  /** Cached culling: for these batches, within `culledRegion` (the canvas
   * region grown by half its size each way, kept while the canvas stays
   * inside it). */
  private culled: Runs | null = null
  private culledBatches: readonly DrawBatch[] | null = null
  private culledRegion: Region | null = null
  /** Instances submitted in the last frame (stats().instances). */
  lastInstances = 0
  /** Render passes the last frame spent on group textures
   * (stats().groupPasses). */
  lastGroupPasses = 0
  /** Render leaf groups into one shared texture and pass
   * (CompositorOptions.groupAtlas). */
  groupAtlas = true
  /** ms the last frame spent recomputing culled runs; 0 when cached
   * (stats().cullMs). */
  lastCullMs = 0
  /** 'band': draw only the viewport plus a band above and below it, the
   * rest kept from earlier frames; 'band-clear': the rest cleared
   * (CompositorOptions.canvasFill). */
  canvasFill: 'full' | 'band' | 'band-clear' = 'band'
  /** canvasFill 'band': rows a re-anchor newly covers are cleared and
   * drawn a strip per frame, nearest the band first, culled to them;
   * false draws them all in the re-anchor frame (not culled to the band). */
  reanchorStrips = true
  /** canvasFill 'band': the canvas's pixels kept between frames (a
   * canvas texture isn't), and a same-size texture to shift them into
   * when the canvas re-anchors. */
  private kept: GPUTexture | null = null
  private keptView: GPUTextureView | null = null
  private keptSpare: GPUTexture | null = null
  /** The main target's ox, oy, sx, sy when `kept` was last drawn. */
  private keptAt: [number, number, number, number] | null = null
  /** Device rows [y0, y1) of `kept` re-anchors newly covered and not yet
   * drawn (cleared), filled a strip per frame (see nextStrip): disjoint,
   * in order (two after re-anchors at both ends). */
  private pending: [number, number][] = []
  /** The pending interval the last strip was taken from (stripRuns). */
  private stripFrom: [number, number] | null = null
  /** canvasFill 'band' with skipUnchanged: device rows of `kept` drawn
   * since the content last changed (disjoint, in order); band rows in it
   * aren't redrawn. */
  private valid: [number, number][] = []
  /** What `valid` was drawn from: the batch list, scene version and
   * material-pipeline settle counter. */
  private validBatches: Scene['batches'] | null = null
  private validVersion = -1
  private validSettled = -1
  /** The rows viewport-space (fixed) content covers, as viewport-y CSS
   * px intervals, merged (cached per batch list and version). */
  private fixedOf: {
    batches: Scene['batches']
    version: number
    rows: [number, number][]
  } | null = null
  /** Scroll position fixed content was last drawn at in `kept` (it sits
   * there until those rows are redrawn). */
  private fixedScrollY: number | null = null
  /** Active non-builtin materials when `valid` was drawn. */
  private validMats: string | null = ''
  /** An extra layer was drawn into `valid` (its pixels stay there until
   * the rows are redrawn without it). */
  private validExtras = false
  /** layerState's key and doc-y rows when `kept` was last drawn. */
  private layerKey = ''
  private layerRows: [number, number][] = []
  /** The largest scroll step of the last 200 ms, CSS px (fillBand). */
  private lastStep = 0
  /** Runs culled to the pending rows (see stripRuns), their region and
   * batch list. */
  private stripCulled: Runs | null = null
  /** Runs culled to 128 CSS px tiles of rows (rowRuns), by tile span,
   * for `rowBatches`. */
  private rowCulled = new Map<string, Runs>()
  private rowBatches: Scene['batches'] | null = null
  private stripRegion: Region | null = null
  private stripBatches: Scene['batches'] | null = null
  private clearRect: ClearRect | null = null
  /** [time, |scroll step|] of the frames of the last 200 ms, CSS px
   * (sizes the band). */
  private steps: [number, number][] = []
  private lastScrollY: number | null = null
  /** The last frame's band in document CSS px (y0, y1), or null when the
   * whole canvas is drawn. */
  private bandY: [number, number] | null = null
  /** Device-px rows a re-anchor covered not yet drawn. */
  get pendingRowCount(): number {
    let n = 0
    for (const [a, b] of this.pending) {
      n += b - a
    }
    return n
  }
  /** Device-px rows the last frame's main pass drew (stats().fillRows). */
  lastFillRows = 0
  /** Frame uniforms for group targets, one per group slot in a frame
   * (sibling groups need distinct buffers: writeBuffer lands before
   * submit). Reused across frames. */
  private readonly groupFrames: FrameSlot[] = []
  /** The effects layer's post chain (gpu/graph.ts). While it is active the
   * scene renders into `sceneTexture` and the chain runs before the canvas
   * composite; otherwise render() draws straight to the swapchain. */
  postChain: PostChain | null = null
  /** Extra layers by id (scene.batches `extra` entries; gpu/graph.ts). */
  readonly extras = new Map<number, ExtraLayer>()
  /** Region handlers by id (OpacityGroup.region; gpu/graph.ts). */
  readonly regions = new Map<number, RegionHandler>()
  /** Layer transforms by id (OpacityGroup.region; gpu/graph.ts). A region
   * handler with the same id takes precedence. */
  readonly transforms = new Map<number, LayerTransform>()
  /** Materials by id (DrawBatch.material; gpu/graph.ts). */
  readonly materials = new Map<number, MaterialEntry>()
  private sceneTexture: GPUTexture | null = null
  private sceneView: GPUTextureView | null = null
  /** What `sceneTexture` holds: the reuseKey and batch list it was drawn
   * from (null: nothing reusable). */
  private sceneKey: string | null = null
  private sceneBatches: readonly DrawBatch[] | null = null
  private copy: CopyThrough | null = null

  constructor(private readonly gpu: GpuContext) {
    this.device = gpu.device
    this.frameBuffer = this.device.createBuffer({
      size: FRAME_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    })
    this.clipBuffer = this.device.createBuffer({
      label: 'clip-shapes',
      size: MAX_CLIP_SHAPES * CLIP_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    })
    const frameLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' }
        }
      ]
    })
    const frameBindGroup = this.device.createBindGroup({
      layout: frameLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuffer } },
        { binding: 1, resource: { buffer: this.clipBuffer } }
      ]
    })
    this.shared = {
      device: this.device,
      format: gpu.viewFormat,
      frameLayout,
      frameBindGroup,
      dpr: 1,
      timer: null
    }
    this.composite = new GroupCompositor(this.shared)
  }

  /** Forget material `id`'s cached pipelines in every pass. */
  dropMaterial(id: number): void {
    this.materials.delete(id)
    for (const pass of this.passes) {
      pass.dropMaterial?.(id)
    }
  }

  /** Start compiling material `mat`'s pipelines in every pass. */
  warmMaterial(mat: MaterialEntry): void {
    for (const pass of this.passes) {
      pass.warmMaterial?.(mat)
    }
  }

  addPass(pass: RenderPass): void {
    this.passes.push(pass)
    this.passByLayer.set(pass.layer, pass)
  }

  private writeFrame(ctx: FrameContext, dpr: number): void {
    // The canvas covers [canvasX, canvasX + canvasWidth) in doc space. A
    // viewport-space position p is at doc p + scroll, so canvas p + scroll
    // - canvasX: vscroll is the canvas origin in viewport space.
    const f = this.frameData
    f[0] = ctx.canvasWidth
    f[1] = ctx.canvasHeight
    f[2] = ctx.canvasX
    f[3] = ctx.canvasY
    f[4] = ctx.time
    f[5] = dpr
    f[6] = ctx.canvasX - ctx.scrollX
    f[7] = ctx.canvasY - ctx.scrollY
    this.device.queue.writeBuffer(this.frameBuffer, 0, f)
  }

  /** `clip`'s shape index in the scene being rendered (0: none). Group
   * clips are indexed when the scene is built, so this only looks up. */
  private clipIndexOf(clip: Rect | null | undefined): number {
    return this.scene?.clipIndex(clip) ?? 0
  }

  /** Upload the scene's clip shapes (slot i + 1 for clipShapes[i]). */
  private writeClips(scene: Scene): void {
    const n = Math.min(scene.clipShapes.length, MAX_CLIP_SHAPES - 1)
    if (n === 0) {
      return
    }
    const d = this.clipData
    for (let i = 0; i < n; i++) {
      const c = scene.clipShapes[i]
      if (!c) {
        continue
      }
      let o = (i + 1) * CLIP_FLOATS
      d[o++] = c.inv[0]
      d[o++] = c.inv[1]
      d[o++] = c.inv[2]
      d[o++] = c.inv[3]
      d[o++] = c.inv[4]
      d[o++] = c.inv[5]
      d[o++] = c.w
      d[o++] = c.h
      for (let k = 0; k < 4; k++) {
        d[o++] = c.radius[k] ?? 0
      }
      for (let k = 0; k < 4; k++) {
        d[o++] = c.radiusY[k] ?? 0
      }
    }
    this.device.queue.writeBuffer(
      this.clipBuffer,
      0,
      d,
      0,
      (n + 1) * CLIP_FLOATS
    )
  }

  /** Frame uniform + bind group 0 for the `slot`th group of this frame. */
  private groupFrame(slot: number): FrameSlot {
    let f = this.groupFrames[slot]
    if (!f) {
      const buffer = this.device.createBuffer({
        size: FRAME_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      })
      const bindGroup = this.device.createBindGroup({
        layout: this.shared.frameLayout,
        entries: [
          { binding: 0, resource: { buffer } },
          { binding: 1, resource: { buffer: this.clipBuffer } }
        ]
      })
      f = { buffer, bindGroup }
      this.groupFrames[slot] = f
    }
    return f
  }

  private beginPass(
    encoder: GPUCommandEncoder,
    t: Target,
    loadOp: GPULoadOp,
    label: string
  ): GPURenderPassEncoder {
    const rp = encoder.beginRenderPass({
      ...timed(this.shared.timer, label),
      colorAttachments: [
        {
          view: t.view,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp,
          storeOp: 'store'
        }
      ]
    })
    rp.setBindGroup(0, t.bindGroup)
    if (t.scissor) {
      rp.setScissorRect(...t.scissor)
    }
    return rp
  }

  /** Back to `t`'s own scissor after a narrower one. */
  private restoreScissor(rp: GPURenderPassEncoder, t: Target): void {
    const [x, y, w, h] = t.scissor ?? [0, 0, t.devW, t.devH]
    rp.setScissorRect(x, y, w, h)
  }

  /** Record this frame's scroll step (sizes the band; also on skipped
   * frames). */
  private noteScroll(ctx: FrameContext): void {
    const dy =
      this.lastScrollY === null ? 0 : Math.abs(ctx.scrollY - this.lastScrollY)
    this.lastScrollY = ctx.scrollY
    const now = performance.now()
    this.steps.push([now, dy])
    while ((this.steps[0]?.[0] ?? now) < now - 200) {
      this.steps.shift()
    }
    let step = 0
    for (const [, d] of this.steps) {
      step = Math.max(step, d)
    }
    this.lastStep = step
  }

  /** Something drawn into the kept texture may differ from what it holds:
   * a dirty layer, a new scene version or batch list, a material pipeline
   * settling, or content drawn differently every frame (viewport-space
   * records, active extra layers, regions, layer transforms, `/fx`
   * materials, backdrops). Doesn't change state. */
  private contentChanged(scene: Scene, ctx: FrameContext): boolean {
    if (
      scene.batches !== this.validBatches ||
      scene.version !== this.validVersion ||
      materialPipelinesSettled() !== this.validSettled ||
      scene.backdrops.length > 0 ||
      this.passes.some((p) => scene.isDirty(p.layer))
    ) {
      return true
    }
    // An active extra layer draws differently every frame; one that was
    // drawn and has stopped leaves its pixels in the kept rows.
    if (this.validExtras || this.extrasActive()) {
      return true
    }
    // Materials: one that may draw differently this frame, or a change in
    // which are active (records switch pipelines).
    if (this.activeMats(true) !== this.validMats) {
      return true
    }
    // Layer transforms and regions are damage (layerState), unless they
    // nest or sit in viewport space.
    return this.layerState(scene, ctx).fallback
  }

  private extrasActive(): boolean {
    for (const layer of this.extras.values()) {
      if (layer.active()) {
        return true
      }
    }
    return false
  }

  /** Ids of the active non-builtin materials; with `changing`, null when
   * one of them may draw differently this frame. */
  private activeMats(changing: boolean): string | null {
    let mats = ''
    for (const [id, m] of this.materials) {
      if (m.builtin || !m.active()) {
        continue
      }
      if (changing && (m.changed?.() ?? true)) {
        return null
      }
      mats += `${id},`
    }
    return mats
  }

  /**
   * The doc-y intervals (CSS px) groups under a layer transform or an
   * active region paint at this frame's values, a key of those values,
   * whether any region is active (it may draw differently every frame),
   * and `fallback` when the damage can't be bounded this way (such groups
   * nested in each other, or in viewport space).
   */
  private layerState(
    scene: Scene,
    ctx: FrameContext
  ): {
    rows: [number, number][]
    key: string
    live: boolean
    fallback: boolean
  } {
    let rows: [number, number][] = []
    let key = ''
    let live = false
    let fallback = false
    const isolated = scene.groups.filter((g) => g.region !== undefined)
    for (const g of isolated) {
      const id = g.region as number
      const region = this.regions.get(id)
      const t = this.transforms.get(id)
      const active = region?.active() ?? false
      if (!active && !t) {
        continue
      }
      if (
        g.space === 'viewport' ||
        g.vbounds !== null ||
        isolated.some((h) => h !== g && h.first <= g.first && g.last <= h.last)
      ) {
        fallback = true
      }
      live ||= active
      const e = groupExtent(g, ctx)
      if (!e) {
        continue
      }
      const pad = (active ? Math.max(0, region?.pad() ?? 0) : 0) + 2
      rows = addRows(rows, e[1] - pad, e[3] + pad)
      if (t) {
        key += `${id}:${t.x},${t.y},${t.scaleX},${t.scaleY},${t.rotate},${t.opacity},${t.originX},${t.originY};`
        const m = layerAffine(g, t, ctx)
        if (m) {
          const r = mapRect(m, e[0], e[1], e[2], e[3])
          rows = addRows(rows, r[1] - pad, r[3] + pad)
        }
      }
      if (active) {
        key += `${id}:r;`
      }
    }
    return { rows, key, live, fallback }
  }

  /** Viewport-y intervals (CSS px) that fixed content paints, padded for
   * anti-aliasing and text shadows. */
  private fixedRows(scene: Scene): [number, number][] {
    const c = this.fixedOf
    if (c && c.batches === scene.batches && c.version === scene.version) {
      return c.rows
    }
    let rows: [number, number][] = []
    const add = (r: Rect, pad: number): void => {
      rows = addRows(rows, r.y - pad, r.y + r.height + pad)
    }
    for (const list of [scene.boxes, scene.images, scene.cutouts]) {
      for (const r of list) {
        if (r.space === 'viewport') {
          add(r.rect, 2)
        }
      }
    }
    for (const run of scene.runs) {
      if (run.space !== 'viewport') {
        continue
      }
      let pad = 2
      for (const sh of run.textShadows ?? []) {
        pad = Math.max(pad, Math.abs(sh.oy) + 1.5 * sh.blur + 2)
      }
      for (const g of run.glyphs) {
        add(g.rect, pad)
      }
    }
    for (const g of scene.groups) {
      if (g.vbounds) {
        add(g.vbounds, 2)
      }
    }
    this.fixedOf = { batches: scene.batches, version: scene.version, rows }
    return rows
  }

  /** Device rows of `t` that fixed content covers with the page scrolled
   * to `scrollY`. */
  private fixedDeviceRows(
    rows: readonly (readonly [number, number])[],
    scrollY: number,
    oy: number,
    sy: number,
    h: number
  ): [number, number][] {
    let out: [number, number][] = []
    for (const [a, b] of rows) {
      const y0 = clamp(Math.floor((a + scrollY - oy) * sy), h)
      const y1 = clamp(Math.ceil((b + scrollY - oy) * sy), h)
      if (y1 > y0) {
        out = addRows(out, y0, y1)
      }
    }
    return out
  }

  /** skipUnchanged: nothing would be drawn this frame (the canvas didn't
   * move, no rows are pending, the content is unchanged and the band's
   * rows are all valid), so no command buffer is needed and the canvas
   * keeps what it last presented. */
  private skipFrame(scene: Scene, ctx: FrameContext, dpr: number): boolean {
    const kept = this.kept
    if (
      !this.skipUnchanged ||
      this.presentedChain ||
      this.canvasFill !== 'band' ||
      !kept ||
      this.pending.length > 0
    ) {
      return false
    }
    const canvas = this.gpu.context.canvas
    const w = canvas.width
    const h = canvas.height
    const sx = ctx.canvasWidth > 0 ? w / ctx.canvasWidth : dpr
    const sy = ctx.canvasHeight > 0 ? h / ctx.canvasHeight : dpr
    const at = this.keptAt
    if (
      kept.width !== w ||
      kept.height !== h ||
      !at ||
      at[0] !== ctx.canvasX ||
      at[1] !== ctx.canvasY ||
      at[2] !== sx ||
      at[3] !== sy ||
      this.contentChanged(scene, ctx)
    ) {
      return false
    }
    const pad = Math.max(128, 2 * this.lastStep)
    const y0 = clamp(Math.floor((ctx.scrollY - pad - ctx.canvasY) * sy), h)
    const y1 = clamp(
      Math.ceil((ctx.scrollY + ctx.height + pad - ctx.canvasY) * sy),
      h
    )
    if (this.fixedScrollY !== ctx.scrollY && this.fixedRows(scene).length > 0) {
      // Fixed content moved against the canvas.
      return false
    }
    const layers = this.layerState(scene, ctx)
    if (layers.live || layers.key !== this.layerKey) {
      // A layer transform moved or a region pass is drawing.
      return false
    }
    return rowsMissing(y0, y1, this.valid).length === 0
  }

  /** The main target's visible band (device px), or undefined for all of
   * it: the viewport plus twice the largest scroll step of the frames of
   * the last 200 ms (at least 128 CSS px) above and below. */
  private fillBand(
    ctx: FrameContext,
    t: Target
  ): [number, number, number, number] | undefined {
    this.bandY = null
    if (this.canvasFill === 'full') {
      return undefined
    }
    const pad = Math.max(128, 2 * this.lastStep)
    const y0 = clamp(Math.floor((ctx.scrollY - pad - t.oy) * t.sy), t.devH)
    const y1 = clamp(
      Math.ceil((ctx.scrollY + ctx.height + pad - t.oy) * t.sy),
      t.devH
    )
    if (y0 === 0 && y1 === t.devH) {
      return undefined
    }
    this.bandY = [ctx.scrollY - pad, ctx.scrollY + ctx.height + pad]
    return [0, y0, t.devW, y1 - y0]
  }

  /**
   * Everything the scene texture depends on beyond the scene's records,
   * or null when something drawing into it changes every frame. While the
   * post chain runs and neither the key nor the records change, the scene
   * is not redrawn: the chain reads last frame's texture (a trail or a lens
   * over a still page). Conservative: an active layer or region pass, or
   * an active material that doesn't report `changed() === false`, forces a
   * redraw; so does a material pipeline finishing (records switch
   * pipelines) and any move of the canvas or the scroll.
   */
  private reuseKey(ctx: FrameContext, dpr: number): string | null {
    if (this.pending.length > 0) {
      // A re-anchor's rows are still being drawn.
      return null
    }
    for (const layer of this.extras.values()) {
      if (layer.active()) {
        return null
      }
    }
    for (const region of this.regions.values()) {
      if (region.active()) {
        return null
      }
    }
    const mats: number[] = []
    for (const [id, m] of this.materials) {
      if (!m.active() || m.builtin) {
        continue
      }
      if (m.changed?.() ?? true) {
        return null
      }
      mats.push(id)
    }
    const xf: number[] = []
    for (const [id, t] of this.transforms) {
      xf.push(
        id,
        t.x,
        t.y,
        t.scaleX,
        t.scaleY,
        t.rotate,
        t.opacity,
        t.originX,
        t.originY
      )
    }
    return [
      ctx.canvasX,
      ctx.canvasY,
      ctx.canvasWidth,
      ctx.canvasHeight,
      ctx.scrollX,
      ctx.scrollY,
      ctx.width,
      ctx.height,
      dpr,
      materialPipelinesSettled(),
      mats.join(','),
      xf.join(',')
    ].join('|')
  }

  /**
   * Walk scene.batches in order. A push ends the current render pass and
   * begins one on a pooled offscreen target (cleared) whose Frame uniform
   * maps the group's viewport-clipped doc rect onto the texture (and, via
   * `vscroll`, the same rect in viewport space for fixed records); the
   * matching pop ends it, resumes the parent target (loadOp 'load') and
   * composites the texture there with the group's alpha. Passes only ever
   * see a render pass with bind group 0 set.
   */
  render(scene: Scene, ctx: FrameContext, dpr: number): void {
    this.scene = scene
    const chain = this.postChain?.active() ? this.postChain : null
    this.noteScroll(ctx)
    if (!chain && this.skipFrame(scene, ctx, dpr)) {
      this.lastSkipped = true
      this.skippedFrames++
      this.lastFillRows = 0
      this.lastBatches = 0
      this.lastDraws = 0
      this.lastInstances = 0
      this.lastGroups = 0
      this.lastGroupPasses = 0
      this.lastUploads = 0
      this.lastUploadMs = 0
      this.lastEncodeMs = 0
      this.lastCullMs = 0
      return
    }
    this.lastSkipped = false
    this.presentedChain = chain !== null
    // Before the uploads clear the dirty flags.
    const changed = this.contentChanged(scene, ctx)
    if (changed) {
      this.valid = []
    }
    const key = chain && this.reuseScene ? this.reuseKey(ctx, dpr) : null
    if (scene.backdrops.length > 0 && !this.canvasSampled) {
      // Backdrops read the canvas texture they were drawn over.
      this.canvasSampled = true
      this.gpu.context.configure({
        device: this.device,
        format: this.gpu.format,
        alphaMode: 'premultiplied',
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      })
    }
    const texture = this.gpu.context.getCurrentTexture()
    if (
      chain &&
      key !== null &&
      key === this.sceneKey &&
      scene.batches === this.sceneBatches &&
      this.sceneTexture?.width === texture.width &&
      this.sceneTexture.height === texture.height &&
      !this.passes.some((p) => scene.isDirty(p.layer))
    ) {
      this.renderPostOnly(chain, texture, ctx, dpr)
      return
    }
    this.lastReused = false
    this.writeFrame(ctx, dpr)
    if (scene.version !== this.clipVersion) {
      this.clipVersion = scene.version
      this.writeClips(scene)
    }
    this.shared.dpr = dpr
    // Upload only the layers that changed since they were last drawn.
    let uploads = 0
    let uploadMs = 0
    const byLayer: Partial<Record<Layer, number>> = {}
    for (const pass of this.passes) {
      if (scene.isDirty(pass.layer)) {
        const t0 = performance.now()
        pass.upload(scene)
        const ms = performance.now() - t0
        uploadMs += ms
        byLayer[pass.layer] = ms
        scene.clearDirty(pass.layer)
        uploads++
      }
    }
    this.lastUploads = uploads
    this.lastUploadMs = uploadMs
    this.lastUploadByLayer = byLayer
    const encodeStart = performance.now()
    const timer = this.shared.timer
    this.frames++
    timer?.begin(this.frames)
    const encoder = this.device.createCommandEncoder()
    const canvasView = texture.createView({ format: this.gpu.viewFormat })
    if (!chain && this.sceneTexture) {
      this.releaseScene()
    }
    const main: Target = {
      view: chain ? this.sceneTarget(texture) : canvasView,
      bindGroup: this.shared.frameBindGroup,
      ox: ctx.canvasX,
      oy: ctx.canvasY,
      devW: texture.width,
      devH: texture.height,
      sx: ctx.canvasWidth > 0 ? texture.width / ctx.canvasWidth : dpr,
      sy: ctx.canvasHeight > 0 ? texture.height / ctx.canvasHeight : dpr,
      group: -1,
      pooled: null,
      rect: [0, 0, 0, 0],
      w: 0,
      h: 0,
      px: 0,
      py: 0,
      xf: null
    }
    let band = this.fillBand(ctx, main)
    let mainLoad: GPULoadOp = 'clear'
    /** Rows newly covered by a re-anchor this frame: cleared first. */
    let cleared: [number, number] | null = null
    /** Pending rows drawn this frame after the band (a second draw). */
    let strip: [number, number, number, number] | undefined
    if (this.canvasFill === 'band') {
      const stale = this.keepMargins(encoder, texture, main)
      main.view = this.keptView ?? canvasView
      if (stale === 'all' || !band) {
        band = undefined
        this.bandY = null
        this.pending = []
      } else {
        mainLoad = 'load'
        if (stale && this.reanchorStrips) {
          cleared = stale
        }
        const pending = this.pending
        if (
          pending.length > 0 &&
          (scene.backdrops.length > 0 || !this.reanchorStrips)
        ) {
          // Rows drawn with the band, not culled to it (a backdrop
          // restarts the pass, so no second draw).
          let y0 = band[1]
          let y1 = band[1] + band[3]
          for (const [a, b] of pending) {
            y0 = Math.min(y0, a)
            y1 = Math.max(y1, b)
          }
          band = [0, y0, main.devW, y1 - y0]
          this.pending = []
          this.bandY = null
        } else if (pending.length > 0) {
          const k = Math.ceil(Math.max(STRIP_MIN, 2 * this.lastStep) * main.sy)
          strip = this.nextStrip(band, main, k)
          if (
            strip &&
            strip[1] <= band[1] + band[3] &&
            strip[1] + strip[3] >= band[1]
          ) {
            // Next to the band: one draw over both, culled to both.
            band = hullRows(band, strip)
            strip = undefined
            if (this.bandY) {
              this.bandY = [
                Math.min(this.bandY[0], band[1] / main.sy + main.oy),
                Math.max(this.bandY[1], (band[1] + band[3]) / main.sy + main.oy)
              ]
            }
          }
        }
      }
    } else if (this.kept) {
      this.releaseKept()
    }
    /** The band's draw is the strip's (culled to the pending rows). */
    let bandIsStrip = false
    /** The band was cut to the rows still to draw: its draw (and the
     * extra draws) are culled to their own rows, not the whole band. */
    let trimmed = false
    /** More rows drawn after the band, each under its own scissor and
     * culled like the band: fixed content's old and new rows when it
     * moved against the canvas (skipUnchanged). */
    const extra: [number, number, number, number][] = []
    if (
      this.canvasFill === 'band' &&
      this.skipUnchanged &&
      band &&
      !changed &&
      mainLoad === 'load'
    ) {
      // Band rows drawn since the content last changed hold the same
      // pixels: draw only the rest, plus where fixed content was and is.
      let need = rowsMissing(band[1], band[1] + band[3], this.valid)
      const fixed = this.fixedRows(scene)
      if (fixed.length > 0 && this.fixedScrollY !== ctx.scrollY) {
        const at = (y: number): [number, number][] =>
          this.fixedDeviceRows(fixed, y, main.oy, main.sy, main.devH)
        for (const [a, b] of [
          ...at(ctx.scrollY),
          ...at(this.fixedScrollY ?? ctx.scrollY)
        ]) {
          need = addRows(need, a, b)
        }
      }
      const layers = this.layerState(scene, ctx)
      if (layers.live || layers.key !== this.layerKey) {
        // Where transformed or region-drawn groups were and are.
        for (const [a, b] of [...layers.rows, ...this.layerRows]) {
          const y0 = clamp(Math.floor((a - main.oy) * main.sy), main.devH)
          const y1 = clamp(Math.ceil((b - main.oy) * main.sy), main.devH)
          if (y1 > y0) {
            need = addRows(need, y0, y1)
          }
        }
      }
      // Rows close together are drawn as one (a draw costs vertex work
      // whatever its scissor).
      const parts: [number, number][] = []
      for (const [a, b] of need) {
        const last = parts[parts.length - 1]
        if (last && a - last[1] < 64) {
          last[1] = b
        } else {
          parts.push([a, b])
        }
      }
      const p0 = parts[0]
      if (p0) {
        trimmed = true
        band = [0, p0[0], main.devW, p0[1] - p0[0]]
        for (const [a, b] of parts.slice(1)) {
          extra.push([0, a, main.devW, b - a])
        }
      } else if (strip) {
        band = strip
        strip = undefined
        bandIsStrip = true
      } else {
        band = [0, 0, main.devW, 0]
      }
    }
    if (this.canvasFill === 'band') {
      // What this frame draws becomes valid.
      if (!band) {
        this.valid = [[0, main.devH]]
      } else {
        for (const r of [band, ...extra, ...(strip ? [strip] : [])]) {
          this.valid = addRows(this.valid, r[1], r[1] + r[3])
        }
      }
      this.validBatches = scene.batches
      this.validVersion = scene.version
      this.validSettled = materialPipelinesSettled()
      // Fixed content is drawn at this scroll wherever it lands.
      this.fixedScrollY = ctx.scrollY
      const layers = this.layerState(scene, ctx)
      this.layerKey = layers.key
      this.layerRows = layers.rows
      this.validMats = this.activeMats(false)
      this.validExtras = this.extrasActive()
    }
    main.scissor = band
    this.lastFillRows =
      (main.scissor ? main.scissor[3] : main.devH) +
      (strip ? strip[3] : 0) +
      extra.reduce((n, r) => n + r[3], 0)
    // A strip or an extra draw composites every group again.
    this.composite.begin(
      scene.groups.length * (1 + extra.length + (strip ? 1 : 0))
    )
    this.groupBlur?.begin()
    if (scene.backdrops.length > 0) {
      this.backdrop ??= new BackdropPass(this.shared)
      let ops = 0
      for (const b of scene.backdrops) {
        ops += b.filter.matrices.length
      }
      this.backdrop.begin(scene.backdrops.length, ops)
    }
    let batches = 0
    let groups = 0
    let groupPasses = 0
    let draws = 0
    let instances = 0
    this.lastCullMs = 0
    let culled = this.cullDraws ? this.cullFor(scene, ctx) : null
    if (bandIsStrip && culled && band) {
      culled = this.stripRuns(scene, ctx, main, band)
    } else if (trimmed && culled && band) {
      culled = this.rowRuns(scene, ctx, main, band)
    }
    let slot = 0
    const list = scene.batches
    // Two phases. Every group's texture is rendered first (children before
    // parents, each in its own pass), then each target's pass draws its
    // batches and composites its child groups in place. A target's pass is
    // split only at a backdrop-filter (drawBackdrop), so groups cost no
    // reload of their parent (the main target is the whole canvas).
    /** By push index: a rendered group, or 'in-place' (drawn in its
     * parent's pass), or 'skip' (nothing to draw). */
    const plan = new Map<number, Target | 'in-place' | 'skip'>()
    // Layer transforms by group, and extents grown by transformed
    // descendants (an enclosing group's texture must hold where they land).
    const xfs: (Affine | null)[] = []
    const extents: (Box4 | null)[] = []
    for (let gi = 0; gi < scene.groups.length; gi++) {
      const g = scene.groups[gi]
      const region =
        g?.region !== undefined ? this.regions.get(g.region) : undefined
      const t =
        g?.region !== undefined && !region?.active()
          ? this.transforms.get(g.region)
          : undefined
      xfs[gi] = g && t ? layerAffine(g, t, ctx) : null
    }
    const popOf = (i: number, group: number): number =>
      skipGroup(list, i, group)

    // Draws list[start, end) into `target`; returns the pass to continue
    // with (a backdrop ends the pass it was given and begins another).
    const drawRange = (
      first: GPURenderPassEncoder,
      target: Target,
      start: number,
      end: number,
      label: string
    ): GPURenderPassEncoder => {
      let rp = first
      for (let i = start; i < end; i++) {
        const batch = list[i]
        if (!batch) {
          continue
        }
        if (batch.kind === 'push') {
          const p = plan.get(i)
          if (p === 'in-place') {
            continue
          }
          const j = popOf(i, batch.group)
          if (p && p !== 'skip') {
            if (
              this.compositeGroup(rp, p, target, scene.groups[batch.group], ctx)
            ) {
              groups++
            }
          }
          i = j
        } else if (batch.kind === 'pop') {
          // An in-place group's pop.
        } else if (batch.kind === 'extra') {
          const layer = this.extras.get(batch.id)
          if (layer?.active()) {
            layer.draw(rp, ctx)
            draws++
          }
        } else if (batch.kind === 'backdrop') {
          const rec = scene.backdrops[batch.index]
          if (rec) {
            rp = this.drawBackdrop(encoder, rp, target, rec, ctx, label)
            draws++
          }
        } else {
          const pass = this.passByLayer.get(batch.layer)
          if (!pass) {
            continue
          }
          const mat =
            batch.material !== undefined
              ? this.materials.get(batch.material)
              : undefined
          const binding = mat?.active() ? mat : null
          const runs = target.group === -1 ? culled?.[i] : null
          if (runs) {
            for (let r = 0; r < runs.length; r += 2) {
              const n = runs[r + 1] ?? 0
              draws += pass.draw(rp, runs[r] ?? 0, n, binding)
              instances += n
            }
          } else {
            draws += pass.draw(rp, batch.first, batch.count, binding)
            instances += batch.count
          }
          batches++
        }
      }
      return rp
    }

    /** Plan and render the groups in list[start, end) drawn into
     * `parent` (recursing into in-place groups' contents). */
    // Groups with nothing inside that needs a pass of its own (nested
    // groups, backdrops, extra layers), no layer transform, region or
    // texture post-processing: they can share one atlas texture and pass.
    const isLeaf = (from: number, to: number): boolean => {
      for (let k = from; k < to; k++) {
        const kind = list[k]?.kind
        if (kind === 'push' || kind === 'backdrop' || kind === 'extra') {
          return false
        }
      }
      return true
    }
    /** Render `leaves` of `parent` (measured, not yet rendered): those
     * that fit share one atlas texture and pass, the rest get their own. */
    const renderLeaves = (leaves: Leaf[]): void => {
      const packed = leaves.length > 1 ? this.packGroups(leaves) : null
      const shared = packed
        ? leaves.filter((_, k) => packed.at[k] !== null).length
        : 0
      for (let k = 0; k < leaves.length; k++) {
        const l = leaves[k] as Leaf
        if (shared > 1 && packed?.at[k]) {
          continue
        }
        const child = this.finishGroup(
          l.m,
          this.composite.acquire(l.m.w, l.m.h),
          0,
          0,
          slot++,
          ctx
        )
        child.group = l.group
        plan.set(l.i, child)
        groupPasses++
        drawRange(
          this.beginPass(encoder, child, 'clear', 'group'),
          child,
          l.i + 1,
          l.j,
          'group'
        ).end()
      }
      if (!packed || shared < 2) {
        return
      }
      const atlas = this.composite.acquireShared(packed.w, packed.h, shared)
      groupPasses++
      const rp = encoder.beginRenderPass({
        ...timed(this.shared.timer, 'group'),
        colorAttachments: [
          {
            view: atlas.view,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store'
          }
        ]
      })
      for (let k = 0; k < leaves.length; k++) {
        const l = leaves[k] as Leaf
        const at = packed.at[k]
        if (!at) {
          continue
        }
        const child = this.finishGroup(l.m, atlas, at[0], at[1], slot++, ctx)
        child.group = l.group
        plan.set(l.i, child)
        rp.setBindGroup(0, child.bindGroup)
        this.restoreScissor(rp, child)
        drawRange(rp, child, l.i + 1, l.j, 'group')
      }
      rp.end()
    }

    const prepare = (parent: Target, start: number, end: number): void => {
      const leaves: Leaf[] = []
      for (let i = start; i < end; i++) {
        const batch = list[i]
        if (batch?.kind !== 'push') {
          continue
        }
        const j = popOf(i, batch.group)
        const g = scene.groups[batch.group]
        const region =
          g?.region !== undefined ? this.regions.get(g.region) : undefined
        const pad = region?.active() ? Math.max(0, region.pad()) : 0
        const t =
          g?.region !== undefined && !region?.active()
            ? this.transforms.get(g.region)
            : undefined
        const tAlpha = t ? layerAlpha(t) : 1
        const xf = xfs[batch.group] ?? null
        if (t && g && !xf && tAlpha === 1 && g.alpha === 1 && !g.filter) {
          // A layer transform at rest: its records draw in place.
          plan.set(i, 'in-place')
          prepare(parent, i + 1, j)
          i = j
          continue
        }
        // Outside the band being drawn (canvasFill: 'band'): nothing of it
        // would land.
        const band = parent.scissor
        const e =
          g && band && !xf && !region?.active()
            ? (extents[batch.group] ?? groupExtent(g, ctx))
            : null
        if (
          e &&
          band &&
          ((e[3] - parent.oy) * parent.sy < band[1] ||
            (e[1] - parent.oy) * parent.sy > band[1] + band[3])
        ) {
          plan.set(i, 'skip')
          i = j
          continue
        }
        if (
          this.groupAtlas &&
          g &&
          !t &&
          !xf &&
          !region?.active() &&
          g.alpha > 0 &&
          !(g.filter && (g.filter.blur > 0 || g.filter.shadows.length > 0)) &&
          isLeaf(i + 1, j)
        ) {
          const m = this.measureGroup(
            g,
            parent,
            ctx,
            0,
            null,
            extents[batch.group] ?? groupExtent(g, ctx)
          )
          if (m) {
            leaves.push({ i, j, group: batch.group, m })
          } else {
            plan.set(i, 'skip')
          }
          i = j
          continue
        }
        const child =
          g && g.alpha * tAlpha > 0
            ? this.openGroup(
                g,
                parent,
                slot,
                ctx,
                pad,
                xf,
                extents[batch.group] ?? groupExtent(g, ctx)
              )
            : null
        if (!child) {
          plan.set(i, 'skip')
          i = j
          continue
        }
        slot++
        child.group = batch.group
        plan.set(i, child)
        prepare(child, i + 1, j)
        const label = region?.active() ? 'region' : t ? 'layer' : 'group'
        groupPasses++
        const rp = drawRange(
          this.beginPass(encoder, child, 'clear', label),
          child,
          i + 1,
          j,
          label
        )
        rp.end()
        const blur = g?.filter?.blur ?? 0
        if (blur > 0 && !region?.active()) {
          this.blurGroup(encoder, child, blur)
        }
        if (g?.filter && !region?.active()) {
          for (const sh of g.filter.shadows) {
            this.shadowGroup(encoder, child, sh)
          }
        }
        if (region?.active() && child.pooled) {
          child.region = this.regionFrame(child, parent, g, encoder, ctx, dpr)
          region.encode(child.region)
        }
        i = j
      }
      if (leaves.length > 0) {
        renderLeaves(leaves)
      }
    }

    if (this.transforms.size > 0) {
      this.growExtents(scene.groups, ctx, xfs, extents)
    }
    // Groups reaching the band, the extra rows or the strip get textures.
    let reach = band
    for (const r of [...extra, ...(strip ? [strip] : [])]) {
      reach = reach ? hullRows(reach, r) : reach
    }
    main.scissor = reach
    prepare(main, 0, list.length)
    main.scissor = band
    const first = this.beginPass(encoder, main, mainLoad, 'main')
    if (mainLoad === 'load') {
      // Kept pixels outside the band stay; the band is redrawn from clear,
      // and rows a re-anchor newly covered are cleared until drawn.
      this.clearRect ??= new ClearRect(this.shared)
      if (cleared) {
        first.setScissorRect(0, cleared[0], main.devW, cleared[1] - cleared[0])
        this.clearRect.draw(first)
        this.restoreScissor(first, main)
      }
      this.clearRect.draw(first)
    }
    let rp = drawRange(first, main, 0, list.length, 'main')
    for (const r of extra) {
      main.scissor = r
      this.restoreScissor(rp, main)
      this.clearRect?.draw(rp)
      if (culled) {
        culled = this.rowRuns(scene, ctx, main, r)
      }
      rp = drawRange(rp, main, 0, list.length, 'main')
    }
    if (extra.length > 0) {
      main.scissor = band
      this.restoreScissor(rp, main)
    }
    if (strip) {
      // The next strip of pending rows: the same batches again under its
      // scissor.
      main.scissor = strip
      this.restoreScissor(rp, main)
      this.clearRect?.draw(rp)
      if (culled) {
        culled = this.stripRuns(scene, ctx, main, strip)
      }
      rp = drawRange(rp, main, 0, list.length, 'main')
      main.scissor = band
    }
    this.lastBatches = batches
    this.lastGroups = groups
    this.lastGroupPasses = groupPasses
    this.lastDraws = draws
    this.lastInstances = instances
    rp.end()
    if (this.kept && this.keptView && main.view === this.keptView) {
      const scene = chain ? this.sceneTexture : null
      if (scene) {
        // The post chain reads its own scene texture (kept as-is on
        // frames that only rerun the chain).
        encoder.copyTextureToTexture(
          { texture: this.kept },
          { texture: scene },
          { width: scene.width, height: scene.height }
        )
      } else {
        this.copy ??= new CopyThrough(this.shared)
        const cp = this.beginPassOn(encoder, canvasView, 'copy')
        this.copy.draw(cp, this.keptView)
        cp.end()
      }
    }
    if (chain && this.sceneView) {
      this.runPost(chain, encoder, canvasView, texture, ctx, dpr)
      this.sceneKey = key
      this.sceneBatches = scene.batches
    }
    this.composite.flush()
    this.backdrop?.flush()
    const readback = timer?.end(encoder)
    this.device.queue.submit([encoder.finish()])
    readback?.()
    this.lastEncodeMs = performance.now() - encodeStart
  }

  /** A frame whose scene is unchanged: only the post chain and the canvas
   * pass run, reading the scene texture the last full render left. */
  private renderPostOnly(
    chain: PostChain,
    texture: GPUTexture,
    ctx: FrameContext,
    dpr: number
  ): void {
    this.writeFrame(ctx, dpr)
    this.shared.dpr = dpr
    this.lastUploads = 0
    this.lastUploadMs = 0
    this.lastUploadByLayer = {}
    this.lastBatches = 0
    this.lastGroups = 0
    this.lastDraws = 0
    this.lastReused = true
    const encodeStart = performance.now()
    const timer = this.shared.timer
    this.frames++
    timer?.begin(this.frames)
    const encoder = this.device.createCommandEncoder()
    const canvasView = texture.createView({ format: this.gpu.viewFormat })
    this.runPost(chain, encoder, canvasView, texture, ctx, dpr)
    const readback = timer?.end(encoder)
    this.device.queue.submit([encoder.finish()])
    readback?.()
    this.lastEncodeMs = performance.now() - encodeStart
  }

  /** The offscreen scene texture for the post path, re-created when the
   * canvas size changes. */
  private sceneTarget(canvas: GPUTexture): GPUTextureView {
    const t = this.sceneTexture
    if (t && t.width === canvas.width && t.height === canvas.height) {
      return this.sceneView ?? t.createView()
    }
    this.releaseScene()
    const texture = this.device.createTexture({
      label: 'post-scene',
      size: { width: canvas.width, height: canvas.height },
      format: this.shared.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST
    })
    this.sceneTexture = texture
    this.sceneView = texture.createView()
    return this.sceneView
  }

  /**
   * canvasFill 'band': make `kept` match the canvas texture and the main
   * target's placement. Returns 'all' when nothing kept is usable (new
   * texture, scale or x change, or a shift that isn't whole rows), the
   * device rows [y0, y1) left without content after shifting the kept
   * pixels to a new anchor, or null when all of them still line up.
   */
  private keepMargins(
    encoder: GPUCommandEncoder,
    canvas: GPUTexture,
    main: Target
  ): 'all' | [number, number] | null {
    const { width: w, height: h } = canvas
    const make = (label: string): GPUTexture =>
      this.device.createTexture({
        label,
        size: { width: w, height: h },
        format: this.shared.format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST
      })
    if (this.kept?.width !== w || this.kept.height !== h) {
      this.releaseKept()
      this.kept = make('kept')
      this.keptView = this.kept.createView()
    }
    const at = this.keptAt
    this.keptAt = [main.ox, main.oy, main.sx, main.sy]
    if (!at || at[0] !== main.ox || at[2] !== main.sx || at[3] !== main.sy) {
      this.valid = []
      return 'all'
    }
    if (at[1] === main.oy) {
      return null
    }
    // Content moves down the texture by `s` rows.
    const s = (at[1] - main.oy) * main.sy
    const r = Math.round(s)
    if (Math.abs(s - r) > 1e-3 || Math.abs(r) >= h || !this.kept) {
      this.valid = []
      return 'all'
    }
    if (this.keptSpare?.width !== w || this.keptSpare.height !== h) {
      this.keptSpare?.destroy()
      this.keptSpare = make('kept-spare')
    }
    encoder.copyTextureToTexture(
      { texture: this.kept, origin: { x: 0, y: Math.max(0, -r) } },
      { texture: this.keptSpare, origin: { x: 0, y: Math.max(0, r) } },
      { width: w, height: h - Math.abs(r) }
    )
    const spare = this.kept
    this.kept = this.keptSpare
    this.keptSpare = spare
    this.keptView = this.kept.createView()
    this.copy?.release()
    const fresh: [number, number] = r > 0 ? [0, r] : [h + r, h]
    // Rows still pending move with the pixels; overlapping intervals
    // merge, disjoint ones stay apart (the rows between are drawn).
    const all: [number, number][] = [fresh]
    for (const [a, b] of this.pending) {
      const y0 = clamp(a + r, h)
      const y1 = clamp(b + r, h)
      if (y1 > y0) {
        all.push([y0, y1])
      }
    }
    all.sort((a, b) => a[0] - b[0])
    const out: [number, number][] = []
    for (const iv of all) {
      const last = out[out.length - 1]
      if (last && iv[0] <= last[1]) {
        last[1] = Math.max(last[1], iv[1])
      } else {
        out.push([iv[0], iv[1]])
      }
    }
    this.pending = out
    // Valid rows move with the pixels too.
    const valid: [number, number][] = []
    for (const [a, b] of this.valid) {
      const y0 = clamp(a + r, h)
      const y1 = clamp(b + r, h)
      if (y1 > y0) {
        valid.push([y0, y1])
      }
    }
    this.valid = valid
    return fresh
  }

  /**
   * The strip of pending rows to draw this frame after `band` (full
   * width; at most `k` rows of the interval nearest the band, from its
   * end next to the band), updating `pending`; undefined when nothing is
   * left. Rows the band covers count as drawn.
   */
  private nextStrip(
    band: [number, number, number, number],
    t: Target,
    k: number
  ): [number, number, number, number] | undefined {
    const b0 = band[1]
    const b1 = band[1] + band[3]
    const left: [number, number][] = []
    for (const [p0, p1] of this.pending) {
      if (p1 <= b0 || p0 >= b1) {
        left.push([p0, p1])
        continue
      }
      if (p0 < b0) {
        left.push([p0, b0])
      }
      if (p1 > b1) {
        left.push([b1, p1])
      }
    }
    let best = -1
    let bestD = Number.POSITIVE_INFINITY
    for (let i = 0; i < left.length; i++) {
      const [p0, p1] = left[i] as [number, number]
      const d = p0 >= b1 ? p0 - b1 : b0 - p1
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    const from = left[best]
    if (!from) {
      this.pending = []
      this.stripFrom = null
      return undefined
    }
    const [p0, p1] = from
    this.stripFrom = [p0, p1]
    let strip: [number, number, number, number]
    if (p0 >= b1) {
      const e = Math.min(p1, p0 + k)
      from[0] = e
      strip = [0, p0, t.devW, e - p0]
    } else {
      const s0 = Math.max(p0, p1 - k)
      from[1] = s0
      strip = [0, s0, t.devW, p1 - s0]
    }
    this.pending = left.filter(([a, b]) => b > a)
    return strip
  }

  private releaseKept(): void {
    this.pending = []
    this.valid = []
    this.stripFrom = null
    this.kept?.destroy()
    this.keptSpare?.destroy()
    this.kept = null
    this.keptSpare = null
    this.keptView = null
    this.keptAt = null
    this.copy?.release()
  }

  private releaseScene(): void {
    this.sceneKey = null
    this.sceneBatches = null
    this.sceneTexture?.destroy()
    this.sceneTexture = null
    this.sceneView = null
    this.copy?.release()
  }

  /**
   * The post path's tail: let the chain record its offscreen stages, then
   * one canvas pass that copies the scene through and has the chain's last
   * stage overwrite the visible viewport grown by the chain's radius.
   */
  private runPost(
    chain: PostChain,
    encoder: GPUCommandEncoder,
    canvasView: GPUTextureView,
    texture: GPUTexture,
    ctx: FrameContext,
    dpr: number
  ): void {
    const scene = this.sceneView
    if (!scene) {
      return
    }
    const W = texture.width
    const H = texture.height
    const sx = ctx.canvasWidth > 0 ? W / ctx.canvasWidth : dpr
    const sy = ctx.canvasHeight > 0 ? H / ctx.canvasHeight : dpr
    const span = (a: number, b: number, s: number, max: number): number[] => [
      clamp(Math.floor(a * s), max),
      clamp(Math.ceil(b * s), max)
    ]
    const [vx0 = 0, vx1 = 0] = span(
      ctx.scrollX - ctx.canvasX,
      ctx.scrollX - ctx.canvasX + ctx.width,
      sx,
      W
    )
    const [vy0 = 0, vy1 = 0] = span(
      ctx.scrollY - ctx.canvasY,
      ctx.scrollY - ctx.canvasY + ctx.height,
      sy,
      H
    )
    const viewport: DeviceRect = {
      x: vx0,
      y: vy0,
      width: vx1 - vx0,
      height: vy1 - vy0
    }
    const r = Math.max(0, chain.radius())
    const rx = Math.ceil(r * sx)
    const ry = Math.ceil(r * sy)
    const x0 = clamp(vx0 - rx, W)
    const y0 = clamp(vy0 - ry, H)
    const rect: DeviceRect = {
      x: x0,
      y: y0,
      width: clamp(vx1 + rx, W) - x0,
      height: clamp(vy1 + ry, H) - y0
    }
    const frame: PostFrame = {
      encoder,
      scene,
      sceneWidth: W,
      sceneHeight: H,
      viewport,
      rect,
      ctx,
      dpr
    }
    const live = viewport.width > 0 && viewport.height > 0
    if (live) {
      chain.encode(frame)
    }
    this.copy ??= new CopyThrough(this.shared)
    const rp = this.beginPassOn(encoder, canvasView)
    if (live) {
      // The chain overwrites `rect`: copy the scene through only around
      // it (up to four bands).
      const bands: [number, number, number, number][] = [
        [0, 0, W, rect.y],
        [0, rect.y + rect.height, W, H - rect.y - rect.height],
        [0, rect.y, rect.x, rect.height],
        [rect.x + rect.width, rect.y, W - rect.x - rect.width, rect.height]
      ]
      for (const [x, y, w, h] of bands) {
        if (w > 0 && h > 0) {
          rp.setScissorRect(x, y, w, h)
          this.copy.draw(rp, scene)
        }
      }
      rp.setScissorRect(rect.x, rect.y, rect.width, rect.height)
      chain.composite(rp, frame)
    } else {
      this.copy.draw(rp, scene)
    }
    rp.end()
  }

  private beginPassOn(
    encoder: GPUCommandEncoder,
    view: GPUTextureView,
    label = 'post'
  ): GPURenderPassEncoder {
    const rp = encoder.beginRenderPass({
      ...timed(this.shared.timer, label),
      colorAttachments: [
        {
          view,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ]
    })
    rp.setBindGroup(0, this.shared.frameBindGroup)
    return rp
  }

  /**
   * Allocate the offscreen target for `g` inside `parent`: the group's
   * bounds (padded 1 CSS px for AA fringes) clipped to the parent target
   * and snapped to its device pixels, so the composite is texel-exact.
   * Null when the clipped region is empty.
   */
  /** extents[i]: group i's extent unioned with where its transformed
   * descendants land (groups are sorted by `first`, parents first). */
  private growExtents(
    groups: readonly OpacityGroup[],
    ctx: FrameContext,
    xfs: readonly (Affine | null)[],
    extents: (Box4 | null)[]
  ): void {
    const parentOf: number[] = []
    const stack: number[] = []
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i] as OpacityGroup
      while (stack.length > 0) {
        const top = groups[stack[stack.length - 1] as number] as OpacityGroup
        if (g.first < top.last) {
          break
        }
        stack.pop()
      }
      parentOf[i] = stack.length > 0 ? (stack[stack.length - 1] as number) : -1
      stack.push(i)
      extents[i] = groupExtent(g, ctx)
    }
    for (let i = groups.length - 1; i >= 0; i--) {
      const e = extents[i]
      const p = parentOf[i] ?? -1
      if (!e || p < 0) {
        continue
      }
      const m = xfs[i]
      const out = m ? mapRect(m, e[0], e[1], e[2], e[3]) : e
      const pe = extents[p]
      extents[p] = pe
        ? [
            Math.min(pe[0], out[0]),
            Math.min(pe[1], out[1]),
            Math.max(pe[2], out[2]),
            Math.max(pe[3], out[3])
          ]
        : [...out]
    }
  }

  /** The handler's view of a rendered region group. */
  private regionFrame(
    top: Target,
    parent: Target,
    g: OpacityGroup | undefined,
    encoder: GPUCommandEncoder,
    ctx: FrameContext,
    dpr: number
  ): RegionFrame {
    const pooled = top.pooled as GroupTarget
    return {
      encoder,
      source: pooled.view,
      sourceWidth: pooled.width,
      sourceHeight: pooled.height,
      x: top.px,
      y: top.py,
      width: top.w,
      height: top.h,
      parentX: parent.ox,
      parentY: parent.oy,
      scale: parent.sx,
      alpha: g?.alpha ?? 1,
      ctx,
      dpr
    }
  }

  /** Draw rendered group `top` into its parent's open pass `rp`: through
   * its region handler, or as a quad (through its layer transform).
   * False when nothing was drawn. */
  private compositeGroup(
    rp: GPURenderPassEncoder,
    top: Target,
    parent: Target,
    g: OpacityGroup | undefined,
    ctx: FrameContext
  ): boolean {
    const pooled = top.pooled
    if (!pooled) {
      return false
    }
    const region =
      g?.region !== undefined ? this.regions.get(g.region) : undefined
    if (top.region && region) {
      const r = meet(
        [top.px, top.py, top.w, top.h],
        parent.scissor ?? [0, 0, parent.devW, parent.devH]
      )
      if (r[2] > 0 && r[3] > 0) {
        rp.setScissorRect(...r)
        region.composite(rp, top.region)
      }
      this.restoreScissor(rp, parent)
      this.composite.release(pooled)
      return true
    }
    const alpha = g?.alpha ?? 1
    const t =
      g?.region !== undefined ? this.transforms.get(g.region) : undefined
    const a = t ? alpha * layerAlpha(t) : alpha
    const [x0, y0, x1, y1] = top.rect
    let quad = rectQuad(top.rect)
    if (top.xf) {
      const m = top.xf
      quad = [
        ...apply(m, x0, y0),
        ...apply(m, x1, y0),
        ...apply(m, x0, y1),
        ...apply(m, x1, y1)
      ]
      // Without rotation the texture maps about 1:1 onto the parent's
      // pixels (rendered at the transform's scale): snap its corner to
      // the parent's pixel grid, or every texel lands between two pixels
      // and the result blurs. Moves it by under a device pixel.
      if (Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6) {
        const qx = ((quad[0] ?? 0) - parent.ox) * parent.sx
        const qy = ((quad[1] ?? 0) - parent.oy) * parent.sy
        const dx = (Math.round(qx) - qx) / parent.sx
        const dy = (Math.round(qy) - qy) / parent.sy
        quad = quad.map((v, i) => v + (i % 2 === 0 ? dx : dy))
      }
    }
    // Moved content stays inside the clips of the element's ancestors
    // (its own records were clipped in the group).
    const sc = top.xf && g ? this.clipScissor(g, parent, ctx) : null
    if (sc && (sc[2] <= 0 || sc[3] <= 0)) {
      this.composite.release(pooled)
      return false
    }
    if (sc && parent.scissor) {
      const r = meet(sc, parent.scissor)
      if (r[2] <= 0 || r[3] <= 0) {
        this.composite.release(pooled)
        return false
      }
      rp.setScissorRect(...r)
    } else if (sc) {
      rp.setScissorRect(sc[0], sc[1], sc[2], sc[3])
    }
    // Inside a rounded/rotated ancestor clip (doc-space groups; the
    // scissor above covers its AABB).
    const shape =
      top.xf && g && g.space !== 'viewport' ? this.clipIndexOf(g.clip) : 0
    this.composite.draw(
      rp,
      pooled,
      quad,
      top.w,
      top.h,
      a,
      shape,
      g?.filter?.matrices,
      top.uv0,
      g?.blend
    )
    if (sc) {
      this.restoreScissor(rp, parent)
    }
    return true
  }

  /** Replace `child`'s texture with its contents blurred by `sigma` CSS
   * px (two passes through pooled targets). */
  private blurGroup(
    encoder: GPUCommandEncoder,
    child: Target,
    sigma: number
  ): void {
    const src = child.pooled
    if (!src) {
      return
    }
    this.groupBlur ??= new GroupBlur(this.shared)
    const blur = this.groupBlur
    // Device px: the group's texture scale (above 1 under a scaling
    // layer transform).
    const s = sigma * Math.max(child.sx, child.sy)
    const mid = this.composite.acquire(child.w, child.h)
    blur.run(encoder, src, mid, child.w, child.h, [1, 0], s)
    this.composite.release(src)
    const out = this.composite.acquire(child.w, child.h)
    blur.run(encoder, mid, out, child.w, child.h, [0, 1], s)
    this.composite.release(mid)
    child.pooled = out
    child.view = out.view
  }

  /** The main target's culled runs (see gpu/cull.ts), recomputed when the
   * batches change or the canvas (or the band being drawn) leaves the
   * cached region. */
  private cullFor(scene: Scene, ctx: FrameContext): Runs {
    const band = this.cullDraws === 'canvas' ? null : this.bandY
    const x0 = ctx.canvasX
    const y0 = band ? band[0] : ctx.canvasY
    const x1 = x0 + ctx.canvasWidth
    const y1 = band ? band[1] : y0 + ctx.canvasHeight
    const r = this.culledRegion
    // Records moved in place under the same batches (Scene.refit): their
    // bounds change, so the runs are recomputed.
    if (updateBounds(scene, scene.batches)) {
      this.culled = null
      this.stripCulled = null
      this.rowCulled.clear()
    }
    if (
      this.culled &&
      this.culledBatches === scene.batches &&
      r &&
      x0 >= r[0] &&
      y0 >= r[1] &&
      x1 <= r[2] &&
      y1 <= r[3]
    ) {
      return this.culled
    }
    const mx = ctx.canvasWidth / 2
    const my = (band ? ctx.height : ctx.canvasHeight) / 2
    const region: Region = [x0 - mx, y0 - my, x1 + mx, y1 + my]
    const t0 = performance.now()
    this.culled = cullRuns(scene, scene.batches, region, (id) => {
      const m = this.materials.get(id)
      return m !== undefined && !m.builtin
    })
    this.lastCullMs = performance.now() - t0
    this.culledBatches = scene.batches
    this.culledRegion = region
    return this.culled
  }

  /** The main target's runs culled to the rows of `r` (device px of `t`),
   * snapped out to 128 CSS px tiles so successive frames reuse them;
   * cached per batch list (a few spans). */
  private rowRuns(
    scene: Scene,
    ctx: FrameContext,
    t: Target,
    r: readonly [number, number, number, number]
  ): Runs {
    if (this.rowBatches !== scene.batches) {
      this.rowCulled.clear()
      this.rowBatches = scene.batches
    }
    const tile = 128
    const a = Math.floor((r[1] / t.sy + t.oy - 8) / tile)
    const b = Math.ceil(((r[1] + r[3]) / t.sy + t.oy + 8) / tile)
    const key = `${a}:${b}`
    const hit = this.rowCulled.get(key)
    if (hit) {
      return hit
    }
    const t0 = performance.now()
    const runs = cullRuns(
      scene,
      scene.batches,
      [ctx.canvasX, a * tile, ctx.canvasX + ctx.canvasWidth, b * tile],
      (id) => {
        const m = this.materials.get(id)
        return m !== undefined && !m.builtin
      }
    )
    this.lastCullMs += performance.now() - t0
    if (this.rowCulled.size >= 16) {
      const first = this.rowCulled.keys().next().value
      if (first !== undefined) {
        this.rowCulled.delete(first)
      }
    }
    this.rowCulled.set(key, runs)
    return runs
  }

  /** The main target's runs culled to `strip` (device rows of `t`) and
   * the pending rows after it, cached until the batches change or a
   * strip leaves the cached rows. */
  private stripRuns(
    scene: Scene,
    ctx: FrameContext,
    t: Target,
    strip: readonly [number, number, number, number]
  ): Runs {
    const y0 = strip[1] / t.sy + t.oy
    const y1 = (strip[1] + strip[3]) / t.sy + t.oy
    const r = this.stripRegion
    if (
      this.stripCulled &&
      this.stripBatches === scene.batches &&
      r &&
      y0 >= r[1] &&
      y1 <= r[3]
    ) {
      return this.stripCulled
    }
    // The whole interval the strip came from: later strips reuse it.
    const p = this.stripFrom
    const py0 = p ? Math.min(y0, p[0] / t.sy + t.oy) : y0
    const py1 = p ? Math.max(y1, p[1] / t.sy + t.oy) : y1
    // A few px past the rows: anti-aliased edges reach past the bounds.
    const region: Region = [
      ctx.canvasX,
      py0 - 8,
      ctx.canvasX + ctx.canvasWidth,
      py1 + 8
    ]
    const t0 = performance.now()
    this.stripCulled = cullRuns(scene, scene.batches, region, (id) => {
      const m = this.materials.get(id)
      return m !== undefined && !m.builtin
    })
    this.lastCullMs += performance.now() - t0
    this.stripBatches = scene.batches
    this.stripRegion = region
    return this.stripCulled
  }

  /** End `rp`, filter what `target` holds under `rec` into a pooled
   * texture (blurred around the border box by 3σ), begin a new pass on
   * `target` and draw it there inside the element's shape. */
  private drawBackdrop(
    encoder: GPUCommandEncoder,
    rp: GPURenderPassEncoder,
    target: Target,
    rec: BackdropRecord,
    ctx: FrameContext,
    label: string
  ): GPURenderPassEncoder {
    const vx = rec.space === 'viewport' ? ctx.scrollX : 0
    const vy = rec.space === 'viewport' ? ctx.scrollY : 0
    const r = rec.rect
    const pad = rec.filter.blur * 3 + 1
    const x0 = clamp(
      Math.floor((r.x + vx - pad - target.ox) * target.sx),
      target.devW
    )
    const y0 = clamp(
      Math.floor((r.y + vy - pad - target.oy) * target.sy),
      target.devH
    )
    const x1 = clamp(
      Math.ceil((r.x + r.width + vx + pad - target.ox) * target.sx),
      target.devW
    )
    const y1 = clamp(
      Math.ceil((r.y + r.height + vy + pad - target.oy) * target.sy),
      target.devH
    )
    const w = x1 - x0
    const h = y1 - y0
    const backdrop = this.backdrop
    if (w <= 0 || h <= 0 || !backdrop) {
      return rp
    }
    rp.end()
    this.groupBlur ??= new GroupBlur(this.shared)
    const blur = this.groupBlur
    // The target as a blur source (its pass has ended).
    const src = {
      view: target.view,
      width: target.pooled?.width ?? target.devW,
      height: target.pooled?.height ?? target.devH
    }
    const s = rec.filter.blur * Math.max(target.sx, target.sy)
    // First pass: the region, shifted to the texture's origin (and
    // blurred across); second: blurred down.
    let out = this.composite.acquire(w, h)
    blur.run(encoder, src, out, w, h, [1, 0], s, { offset: [-x0, -y0] })
    if (s >= 0.01) {
      const mid = out
      out = this.composite.acquire(w, h)
      blur.run(encoder, mid, out, w, h, [0, 1], s)
      this.composite.release(mid)
    }
    const next = this.beginPass(encoder, target, 'load', label)
    backdrop.draw(next, out, rec, x0, y0, this.clipIndexOf(rec.clip))
    this.composite.release(out)
    return next
  }

  /** Replace `child`'s texture with its contents over `sh`, their
   * drop shadow (two passes through pooled targets). */
  private shadowGroup(
    encoder: GPUCommandEncoder,
    child: Target,
    sh: DropShadow
  ): void {
    const src = child.pooled
    if (!src) {
      return
    }
    this.groupBlur ??= new GroupBlur(this.shared)
    const blur = this.groupBlur
    const s = sh.sigma * Math.max(child.sx, child.sy)
    const [r, g, b, a] = sh.color
    const mid = this.composite.acquire(child.w, child.h)
    blur.run(encoder, src, mid, child.w, child.h, [1, 0], s, {
      offset: [sh.dx * child.sx, sh.dy * child.sy]
    })
    const out = this.composite.acquire(child.w, child.h)
    blur.run(encoder, mid, out, child.w, child.h, [0, 1], s, {
      shadow: { tint: [r * a, g * a, b * a, a], orig: src }
    })
    this.composite.release(mid)
    this.composite.release(src)
    child.pooled = out
    child.view = out.view
  }

  /** The parent-target scissor (x, y, w, h device px) for `g`'s
   * ancestors' clip, or null when it has none. */
  private clipScissor(
    g: OpacityGroup,
    parent: Target,
    ctx: FrameContext
  ): [number, number, number, number] | null {
    const c = g.clip
    if (!c) {
      return null
    }
    const vx = g.space === 'viewport' ? ctx.scrollX : 0
    const vy = g.space === 'viewport' ? ctx.scrollY : 0
    const x0 = clamp(
      Math.floor((c.x + vx - parent.ox) * parent.sx),
      parent.devW
    )
    const y0 = clamp(
      Math.floor((c.y + vy - parent.oy) * parent.sy),
      parent.devH
    )
    const x1 = clamp(
      Math.ceil((c.x + vx + c.width - parent.ox) * parent.sx),
      parent.devW
    )
    const y1 = clamp(
      Math.ceil((c.y + vy + c.height - parent.oy) * parent.sy),
      parent.devH
    )
    return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)]
  }

  private openGroup(
    g: OpacityGroup,
    parent: Target,
    slot: number,
    ctx: FrameContext,
    pad = 0,
    xf: Affine | null = null,
    extent: Box4 | null = groupExtent(g, ctx)
  ): Target | null {
    const m = this.measureGroup(g, parent, ctx, pad, xf, extent)
    return m
      ? this.finishGroup(m, this.composite.acquire(m.w, m.h), 0, 0, slot, ctx)
      : null
  }

  /** Where `g`'s texture sits in `parent` and at what scale (see
   * openGroup); null when nothing of it can land. */
  private measureGroup(
    g: OpacityGroup,
    parent: Target,
    ctx: FrameContext,
    pad: number,
    xf: Affine | null,
    extent: Box4 | null
  ): GroupPlace | null {
    if (!extent) {
      return null
    }
    const [bx0, by0, bx1, by1] = extent
    const p = 1 + pad
    let x0: number
    let y0: number
    let x1: number
    let y1: number
    const inv = xf ? invert(xf) : null
    if (xf && !inv) {
      // Scaled to nothing: nothing to draw.
      return null
    }
    if (inv) {
      // Under a layer transform: render the part of the group that can
      // land on the parent (its rect mapped back), not the part that sits
      // on it untransformed.
      // The parent's rect, cut to the ancestors' clip the result gets.
      let px0 = parent.ox
      let py0 = parent.oy
      let px1 = parent.ox + parent.devW / parent.sx
      let py1 = parent.oy + parent.devH / parent.sy
      const c = g.clip
      if (c) {
        const vx = g.space === 'viewport' ? ctx.scrollX : 0
        const vy = g.space === 'viewport' ? ctx.scrollY : 0
        px0 = Math.max(px0, c.x + vx)
        py0 = Math.max(py0, c.y + vy)
        px1 = Math.min(px1, c.x + vx + c.width)
        py1 = Math.min(py1, c.y + vy + c.height)
        if (px1 <= px0 || py1 <= py0) {
          return null
        }
      }
      const [ix0, iy0, ix1, iy1] = mapRect(inv, px0, py0, px1, py1)
      const max = this.device.limits.maxTextureDimension2D
      x0 = Math.floor((Math.max(bx0 - p, ix0) - parent.ox) * parent.sx)
      y0 = Math.floor((Math.max(by0 - p, iy0) - parent.oy) * parent.sy)
      x1 = Math.min(
        Math.ceil((Math.min(bx1 + p, ix1) - parent.ox) * parent.sx),
        x0 + max
      )
      y1 = Math.min(
        Math.ceil((Math.min(by1 + p, iy1) - parent.oy) * parent.sy),
        y0 + max
      )
    } else {
      x0 = clamp(Math.floor((bx0 - p - parent.ox) * parent.sx), parent.devW)
      y0 = clamp(Math.floor((by0 - p - parent.oy) * parent.sy), parent.devH)
      x1 = clamp(Math.ceil((bx1 + p - parent.ox) * parent.sx), parent.devW)
      y1 = clamp(Math.ceil((by1 + p - parent.oy) * parent.sy), parent.devH)
    }
    if (x1 <= x0 || y1 <= y0) {
      return null
    }
    // Under a transform the texture is rendered at the transform's scale
    // (k device px per parent device px), within the size limit.
    let kx = 1
    let ky = 1
    if (inv && xf) {
      const max = this.device.limits.maxTextureDimension2D
      ;[kx, ky] = axisScales(xf)
      kx = Math.min(kx, max / (x1 - x0))
      ky = Math.min(ky, max / (y1 - y0))
    }
    return {
      w: Math.max(1, Math.ceil((x1 - x0) * kx)),
      h: Math.max(1, Math.ceil((y1 - y0) * ky)),
      sx: parent.sx * kx,
      sy: parent.sy * ky,
      ox: parent.ox + x0 / parent.sx,
      oy: parent.oy + y0 / parent.sy,
      px: x0,
      py: y0,
      kx,
      ky,
      xf: inv ? xf : null
    }
  }

  /**
   * Shelf-pack `leaves`' textures (tallest first) into one atlas no wider
   * or taller than the device allows, with ATLAS_GUTTER between rects.
   * Returns the used size and each one's top-left (null: didn't fit).
   */
  private packGroups(leaves: readonly Leaf[]): {
    w: number
    h: number
    at: ([number, number] | null)[]
  } {
    const max = this.device.limits.maxTextureDimension2D
    let area = 0
    let widest = 0
    for (const l of leaves) {
      area += (l.m.w + ATLAS_GUTTER) * (l.m.h + ATLAS_GUTTER)
      widest = Math.max(widest, l.m.w + ATLAS_GUTTER)
    }
    const width = Math.min(max, Math.max(widest, Math.ceil(Math.sqrt(area))))
    const order = leaves.map((_, k) => k)
    order.sort((a, b) => (leaves[b]?.m.h ?? 0) - (leaves[a]?.m.h ?? 0))
    const at: ([number, number] | null)[] = leaves.map(() => null)
    let x = 0
    let y = 0
    let shelf = 0
    let used = 0
    for (const k of order) {
      const m = (leaves[k] as Leaf).m
      if (x + m.w > width) {
        x = 0
        y += shelf + ATLAS_GUTTER
        shelf = 0
      }
      if (m.w > width || y + m.h > max) {
        continue
      }
      at[k] = [x, y]
      x += m.w + ATLAS_GUTTER
      used = Math.max(used, x)
      shelf = Math.max(shelf, m.h)
    }
    return { w: Math.max(1, used), h: Math.max(1, y + shelf), at }
  }

  /** The target for a measured group drawn from device px (ax, ay) of
   * `pooled` (a texture of its own: 0, 0; a group atlas: its rect). */
  private finishGroup(
    m: GroupPlace,
    pooled: GroupTarget,
    ax: number,
    ay: number,
    slot: number,
    ctx: FrameContext
  ): Target {
    const { w, h, sx, sy, ox, oy, kx, ky } = m
    // The frame maps the texture's origin, (ax, ay) device px before the
    // group's own.
    const tx = ox - ax / sx
    const ty = oy - ay / sy
    const frame = this.groupFrame(slot)
    const f = this.frameData
    f[0] = pooled.width / sx
    f[1] = pooled.height / sy
    f[2] = tx
    f[3] = ty
    f[4] = ctx.time
    // Device px per CSS px in this target (Slug's AA pad reads it).
    f[5] = this.shared.dpr * Math.max(kx, ky)
    // The target origin in viewport space, for viewport-space records: doc
    // origin minus the real scroll (not the parent's origin, which is the
    // canvas anchor on the main target).
    f[6] = tx - ctx.scrollX
    f[7] = ty - ctx.scrollY
    this.device.queue.writeBuffer(frame.buffer, 0, f)
    const t: Target = {
      view: pooled.view,
      bindGroup: frame.bindGroup,
      ox: tx,
      oy: ty,
      devW: pooled.width,
      devH: pooled.height,
      sx,
      sy,
      group: -1,
      pooled,
      rect: [ox, oy, ox + w / sx, oy + h / sy],
      w,
      h,
      px: m.px,
      py: m.py,
      xf: m.xf
    }
    if (pooled.refs !== undefined) {
      t.uv0 = [ax, ay]
      t.scissor = [ax, ay, w, h]
    }
    return t
  }

  /** Time render passes on the GPU (needs `timestamp-query`); results
   * reach `onResult` a frame or two later. Returns whether timing runs. */
  setGpuTiming(onResult: ((t: GpuFrameTiming) => void) | null): boolean {
    this.shared.timer?.destroy()
    this.shared.timer = null
    if (onResult && GpuTimer.supported(this.device)) {
      this.shared.timer = new GpuTimer(this.device, onResult)
    }
    return this.shared.timer !== null
  }

  /** GPU timing readbacks still in flight. */
  get gpuTimingPending(): number {
    return this.shared.timer?.pending ?? 0
  }

  destroy(): void {
    this.setGpuTiming(null)
    this.groupBlur?.destroy()
    this.backdrop?.destroy()
    for (const pass of this.passes) {
      pass.destroy()
    }
    this.frameBuffer.destroy()
    this.clipBuffer.destroy()
    for (const f of this.groupFrames) {
      f.buffer.destroy()
    }
    this.composite.destroy()
    this.releaseScene()
    this.releaseKept()
  }
}
