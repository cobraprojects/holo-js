import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    config: 'src/config.ts',
    client: 'src/client.ts',
    contracts: 'src/contracts.ts',
    'next/server': 'src/next/server.ts',
    'nuxt/server': 'src/nuxt/server.ts',
    'sveltekit/server': 'src/sveltekit/server.ts',
    'drivers/redis-adapter': 'src/drivers/redis-adapter.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  external: ['h3', 'next/server'],
  esbuildOptions(options) {
    options.logLevel = 'warning'
  },
})
