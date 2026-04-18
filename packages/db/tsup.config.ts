import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm'],
  external: [
    '@holo-js/db-sqlite',
    '@holo-js/db-postgres',
    '@holo-js/db-mysql',
  ],
  dts: true,
  clean: true,
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  onSuccess: 'echo "Build complete"',
  esbuildOptions(options) {
    options.logLevel = 'warning'
  },
})
