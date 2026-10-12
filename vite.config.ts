import { resolve } from 'node:path'
import typegpu from 'unplugin-typegpu/vite'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

// Two modes:
//   `vite`        → dev server for the playground (root = ./playground)
//   `vite build`  → library build of ./src into ./dist: four entries,
//                   `compositor-gpu` (dist/compositor-gpu.js),
//                   `compositor-gpu/fx` (dist/fx.js), `compositor-gpu/react`
//                   (dist/react.js) and `compositor-gpu/dials`
//                   (dist/dials.js), sharing chunks
export default defineConfig(({ command }) => {
  if (command === 'serve') {
    return {
      root: 'playground',
      // JS-bodied ('use gpu') tgpu.fn in the fx playground.
      plugins: [typegpu({})],
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
          fx: resolve(import.meta.dirname, 'src/fx/index.ts'),
          react: resolve(import.meta.dirname, 'src/react/index.ts'),
          dials: resolve(import.meta.dirname, 'src/dials/index.ts')
        },
        formats: ['es'],
        fileName: (_format, name) =>
          name === 'index' ? 'compositor-gpu.js' : `${name}.js`
      },
      rollupOptions: {
        // keep heavy deps external so host apps dedupe them; react and
        // dialkit are optional peers
        external: ['typegpu', 'opentype.js', 'react', /^dialkit(\/|$)/]
      },
      sourcemap: true,
      target: 'esnext'
    }
  }
})
