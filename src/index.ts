import './util/env'

export { createCompositor } from './compositor'
export { FRAME_BYTES, FRAME_WGSL, type Shared } from './gpu/frame'
export type {
  DeviceRect,
  FrameHook,
  PostChain,
  PostFrame,
  RenderGraph
} from './gpu/graph'
export type { GpuFrameTiming, GpuSpan } from './gpu/timer'
export {
  type CpuBreakdown,
  type FrameSample,
  formatReport,
  type Hitch,
  type LongFrame,
  type Pct,
  type Profile,
  type ProfileOptions,
  type ProfileReport,
  type ProfileSummary,
  type ReadKind
} from './profile/profiler'
export type {
  BoxRecord,
  Glyph,
  GlyphRun,
  ImageRecord,
  Rect,
  RGBA,
  SceneRecord
} from './scene/records'
export { SlugText } from './text/slug/rasterizer'
export type { TextBackend } from './text/textRasterizer'
export type {
  Compositor,
  CompositorOptions,
  CompositorStats,
  Fallback,
  FontDescriptor,
  FrameContext,
  Layer,
  Mode,
  PointerClick,
  PointerState
} from './types'
