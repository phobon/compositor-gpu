import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

// Two modes:
//   `vite`        → dev server for the playground (root = ./playground)
//   `vite build`  → library build of ./src into ./dist
export default defineConfig(({ command }) => {
  if (command === 'serve') {
    return {
      root: 'playground',
      resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
      server: { open: true }
    }
  }

  return {
    resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
    plugins: [dts({ rollupTypes: true, include: ['src'] })],
    build: {
      lib: {
        entry: resolve(import.meta.dirname, 'src/index.ts'),
        name: 'CompositorGPU',
        formats: ['es'],
        fileName: () => 'compositor-gpu.js'
      },
      rollupOptions: {
        // keep heavy deps external so host apps dedupe them
        external: ['typegpu', 'opentype.js']
      },
      sourcemap: true,
      target: 'esnext'
    }
  }
})
