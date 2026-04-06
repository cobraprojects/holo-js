import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

const sharedOptions = {
  format: ['esm'] as const,
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  esbuildOptions(options: { logLevel?: string }) {
    options.logLevel = 'warning'
  },
}

export default defineConfig([
  {
    ...sharedOptions,
    entry: {
      'index': 'src/index.ts',
    },
    dts: true,
    clean: true,
  },
  {
    ...sharedOptions,
    entry: {
      'bin/holo': 'src/bin/holo.ts',
    },
    dts: false,
    clean: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
])
