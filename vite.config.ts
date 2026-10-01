import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

// Two modes:
//   `vite`        → dev server for the playground (root = ./playground)
//   `vite build`  → library build of ./src into ./dist: two entries,
//                   `compositor-gpu` (dist/compositor-gpu.js) and
//                   `compositor-gpu/fx` (dist/fx.js), sharing chunks
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
        entry: {
          index: resolve(import.meta.dirname, 'src/index.ts'),
          fx: resolve(import.meta.dirname, 'src/fx/index.ts')
        },
        formats: ['es'],
        fileName: (_format, name) =>
          name === 'index' ? 'compositor-gpu.js' : `${name}.js`
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
