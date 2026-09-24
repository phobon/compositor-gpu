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
