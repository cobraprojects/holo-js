import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm'],
  external: ['sharp'],
  dts: true,
  clean: true,
  outDir: 'dist',
  outExtension: () => ({ js: '.mjs' }),
  onSuccess: 'echo "Build complete"',
  esbuildOptions(options) {
    options.logLevel = 'warning'
  },
})
