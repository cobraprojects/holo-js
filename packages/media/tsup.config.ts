import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    projectConfig: 'src/projectConfig.ts',
  },
  format: ['esm'],
  external: ['sharp'],
  dts: true,
  clean: true,
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  onSuccess: 'echo "Build complete"',
  esbuildOptions(options) {
    options.logLevel = 'warning'
  },
})
