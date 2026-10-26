const PREFIX = '[compositor-gpu]'
let enabled = false

export function setDebug(on: boolean): void {
  enabled = on
}

export const log = {
  info: (...a: unknown[]) => enabled && console.info(PREFIX, ...a),
  warn: (...a: unknown[]) => console.warn(PREFIX, ...a),
  error: (...a: unknown[]) => console.error(PREFIX, ...a)
}

/** Surface WGSL compile errors to the console (async, best-effort). */
export function reportShaderErrors(
  module: GPUShaderModule,
  label: string
): void {
  void module.getCompilationInfo().then((info) => {
    for (const m of info.messages) {
      if (m.type === 'error') {
        log.error(`${label} shader ${m.lineNum}:${m.linePos} — ${m.message}`)
      }
    }
  })
}

const reported = new Set<string>()

/**
 * Run author code (an effect's `update`, a page's `onFrame`) so that a
 * throw can't escape into the frame loop: it is logged once per `label`
 * and message, and the frame carries on without it.
 */
export function guarded(label: string, f: () => void): void {
  try {
    f()
  } catch (err) {
    const key = `${label}\u0000${err instanceof Error ? err.message : String(err)}`
    if (!reported.has(key)) {
      if (reported.size > 256) {
        reported.clear()
      }
      reported.add(key)
      log.error(`${label} threw (logged once; the frame continues):`, err)
    }
  }
}
