import type { RenderPass } from '../gpu/frame'

/**
 * A text backend is a RenderPass that also knows how to prepare fonts. The
 * default backend is Slug (outline-based, atlas-free). An MSDF backend can
 * implement the same interface for constrained targets.
 *
 * The compositor applies the per-glyph onGlyph hook to the scene records
 * BEFORE calling upload(), so a backend only needs to read glyph.rect + offset.
 */
export interface TextBackend extends RenderPass {
  readonly name: string
  /** True once at least one font is parsed and the backend can draw. */
  readonly ready: boolean
  /** Parse font faces into GPU-ready glyph data. Resolves fontIds. */
  prepare(fonts: FontFace[]): Promise<void>
}
