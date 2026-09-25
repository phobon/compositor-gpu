// typegpu reads `globalThis.process.env.NODE_ENV` at module evaluation.
// Bundlers only substitute the bare `process.env.NODE_ENV` form, so in a
// browser without a `process` global the import throws before anything runs.
// This module is imported first from index.ts so the shim exists in time.
// In Node (SSR) `process` is real and untouched.
const g = globalThis as { process?: { env?: Record<string, string> } }
if (!g.process) {
  g.process = { env: { NODE_ENV: 'production' } }
} else if (!g.process.env) {
  g.process.env = { NODE_ENV: 'production' }
}
