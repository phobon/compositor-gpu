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
