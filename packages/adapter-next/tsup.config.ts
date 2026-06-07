import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    config: 'src/config.ts',
    client: 'src/client.ts',
    realtime: 'src/realtime.ts',
    'realtime-definition-loader': 'src/realtime-definition-loader.ts',
    runtime: 'src/runtime.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  external: ['@holo-js/realtime', '@holo-js/realtime/client', 'react', 'next/headers.js', 'next/navigation.js'],
  esbuildOptions(options) {
    options.logLevel = 'warning'
  },
})
