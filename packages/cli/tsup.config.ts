import { defineConfig, type Options } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

const sharedOptions: Pick<Options, 'format' | 'outDir' | 'outExtension' | 'esbuildOptions'> = {
  format: ['esm'],
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  esbuildOptions(options) {
    options.logLevel = 'warning'
  },
}

export default defineConfig([
  {
    ...sharedOptions,
    entry: {
      'index': 'src/index.ts',
      'project-prepare-worker': 'src/project-prepare-worker.ts',
      'runtime-worker': 'src/runtime-worker.ts',
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
  },
])
