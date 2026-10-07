import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client.ts',
    build: 'src/build.ts',
    'sveltekit/request-context': 'src/sveltekit/request-context.ts',
    'next/request-context': 'src/next/request-context.ts',
    'next/request-context.node': 'src/next/request-context.node.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  external: ['typescript'],
})
