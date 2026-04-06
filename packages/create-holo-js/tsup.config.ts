import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  format: ['esm'],
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  entry: {
    'bin/create-holo-js': 'src/bin/create-holo-js.ts',
  },
  dts: false,
  clean: true,
  external: ['@holo-js/cli'],
  banner: {
    js: '#!/usr/bin/env node',
  },
  esbuildOptions(options: { logLevel?: string }) {
    options.logLevel = 'warning'
  },
})
