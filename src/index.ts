import './util/env'

export { createCompositor } from './create'
export { FRAME_BYTES, FRAME_WGSL, type Shared } from './gpu/frame'
export type {
  DeviceRect,
  FrameHook,
  PostChain,
  PostFrame,
  RenderGraph
} from './gpu/graph'
export type { GpuFrameTiming, GpuSpan } from './gpu/timer'
export type { Factor, FactorKind } from './profile/explain'
export {
  type CpuBreakdown,
  type FrameSample,
  formatReport,
  type Hitch,
  type LongFrame,
  type LongFrameScript,
  type Pct,
  type Profile,
  type ProfileOptions,
  type ProfileReport,
  type ProfileSummary,
  type ReadKind
} from './profile/profiler'
export {
  decodeRecording,
  encodeRecording,
  RECORDING_FORMAT,
  RECORDING_VERSION,
  type Recording,
  recordingFileName,
  toRecording
} from './profile/recording'
export type { FrameWhy, TraceEvent } from './profile/trace'
export type { FilmFrame, FilmstripOptions } from './profile/filmstrip'
export type {
  BoxRecord,
  Glyph,
  GlyphRun,
  ImageRecord,
  Rect,
  RGBA,
  SceneRecord
} from './scene/records'
export type { SlugText } from './text/slug/rasterizer'
export type { TextBackend } from './text/text_rasterizer'
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
