import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    config: 'src/config.ts',
    client: 'src/client.ts',
    'internal/validation-errors': 'src/validation-errors.ts',
    'internal/validation-layout': 'src/validation-layout.ts',
    realtime: 'src/realtime.ts',
    'validation-loader': 'src/validation-loader.ts',
    'route-loader': 'src/route-loader.ts',
    'server-action-loader': 'src/server-action-loader.ts',
    'layout-loader': 'src/layout-loader.ts',
    'realtime-definition-loader': 'src/realtime-definition-loader.ts',
    runtime: 'src/runtime.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  external: ['@holo-js/realtime', '@holo-js/realtime/client', '@holo-js/adapter-next/internal/validation-errors', 'react', 'next/headers.js', 'next/navigation.js'],
  esbuildOptions(options) {
    options.logLevel = 'warning'
  },
})
