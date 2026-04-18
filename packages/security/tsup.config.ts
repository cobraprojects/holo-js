import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client.ts',
    contracts: 'src/contracts.ts',
    'drivers/redis-adapter': 'src/drivers/redis-adapter.ts',
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
