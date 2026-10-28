// Recordings (docs/PROFILER.md, format v1): a profile report with what
// is needed to open it elsewhere (the devtools viewer, the CLI's HTML
// report, another machine), as JSON, gzipped on export. A report from
// `profile.stop()` or `profile.save()` (the flight recorder) already
// holds its samples, long animation frames, marks, hitches with their
// factors, element paths and environment; the recording adds the format,
// version, kind and when it was saved.

import type { ProfileReport } from './profiler'

export const RECORDING_FORMAT = 'compositor-gpu/recording'
export const RECORDING_VERSION = 1

export interface Recording {
  format: typeof RECORDING_FORMAT
  version: number
  /** 'recording': profile.start() to stop(); 'flight': the flight
   * recorder's window at save(). */
  kind: 'recording' | 'flight'
  /** ISO time it was saved. */
  savedAt: string
  /** Free text (a scenario name, a note). */
  title?: string
  report: ProfileReport
}

export function toRecording(
  report: ProfileReport,
  kind: Recording['kind'],
  title?: string
): Recording {
  const r: Recording = {
    format: RECORDING_FORMAT,
    version: RECORDING_VERSION,
    kind,
    savedAt: new Date().toISOString(),
    report
  }
  if (title) {
    r.title = title
  }
  return r
}

/** As JSON bytes, gzipped (CompressionStream) unless `gzip` is false. */
export async function encodeRecording(
  r: Recording,
  gzip = true
): Promise<Uint8Array> {
  // Samples hold the frame before each hitch again (Hitch.before): drop
  // the copy, the viewer finds it by time.
  const json = JSON.stringify(r, (k, v) => (k === 'before' ? undefined : v))
  const bytes = new TextEncoder().encode(json)
  if (!gzip || typeof CompressionStream === 'undefined') {
    return bytes
  }
  const out = await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer()
  return new Uint8Array(out)
}

/** A recording from bytes (gzipped or not) or JSON text. Throws on
 * anything else, or a newer version than this build reads. */
export async function decodeRecording(
  data: ArrayBuffer | Uint8Array | string
): Promise<Recording> {
  let text: string
  if (typeof data === 'string') {
    text = data
  } else {
    let bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      bytes = new Uint8Array(
        await new Response(
          new Blob([bytes as Uint8Array<ArrayBuffer>])
            .stream()
            .pipeThrough(new DecompressionStream('gzip'))
        ).arrayBuffer()
      )
    }
    text = new TextDecoder().decode(bytes)
  }
  const r = JSON.parse(text) as Partial<Recording>
  if (r.format !== RECORDING_FORMAT || !r.report) {
    throw new Error('not a compositor-gpu recording')
  }
  if ((r.version ?? 0) > RECORDING_VERSION) {
    throw new Error(
      `recording version ${r.version}; this build reads up to ${RECORDING_VERSION}`
    )
  }
  for (const h of r.report.hitches ?? []) {
    h.before ??= null
  }
  return r as Recording
}

/** A file name for a recording: `compositor-gpu-<kind>-<time>.cgprof`. */
export function recordingFileName(r: Recording): string {
  const t = r.savedAt.replace(/[:.]/g, '-').replace(/Z$/, '')
  return `compositor-gpu-${r.kind}-${t}.cgprof`
}
