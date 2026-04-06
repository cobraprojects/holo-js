import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'runtime/composables/index': 'src/runtime/composables/index.ts',
    'runtime/drivers/s3': 'src/runtime/drivers/s3.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  esbuildOptions(options) {
    options.logLevel = 'warning'
  },
})
