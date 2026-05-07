import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client.ts',
    'next/client': 'src/next/client.ts',
    'next/server': 'src/next/server.ts',
    'sveltekit/client': 'src/sveltekit/client.ts',
    'sveltekit/server': 'src/sveltekit/server.ts',
    nuxt: 'src/nuxt.ts',
    'nuxt/server': 'src/nuxt/server.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  external: ['#imports', 'react', 'svelte', 'svelte/reactivity'],
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  esbuildOptions(options) {
    options.logLevel = 'warning'
  },
})
