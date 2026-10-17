import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client.ts',
    server: 'src/server.ts',
  },
  outDir,
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outExtension: () => ({ js: '.mjs' }),
  external: [
    '@holo-js/auth',
    '@holo-js/db',
    '@holo-js/validation',
    'esbuild',
  ],
})
