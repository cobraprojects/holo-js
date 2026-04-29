import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    config: 'src/config.ts',
    client: 'src/client.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  outExtension: () => ({ js: '.mjs' }),
  external: ['react'],
  esbuildOptions(options) {
    options.logLevel = 'warning'
  },
})
