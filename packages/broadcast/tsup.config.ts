import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    auth: 'src/auth.ts',
    contracts: 'src/contracts.ts',
    runtime: 'src/runtime.ts',
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
