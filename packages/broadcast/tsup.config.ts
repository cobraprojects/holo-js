import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    config: 'src/config.ts',
    auth: 'src/auth.ts',
    'client-config': 'src/client-config.ts',
    contracts: 'src/contracts.ts',
    runtime: 'src/runtime.ts',
  },
  external: ['ioredis'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  esbuildOptions(options) {
    options.logLevel = 'warning'
  },
})
