import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client.ts',
    transport: 'src/transport.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  external: ['$app/stores', 'svelte/reactivity', 'svelte/store'],
  esbuildOptions(options) {
    options.logLevel = 'warning'
  },
})
