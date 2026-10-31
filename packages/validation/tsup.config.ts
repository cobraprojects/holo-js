import { build, defineConfig, type Options } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

const shared = {
  format: ['esm'],
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  esbuildOptions(options) {
    options.logLevel = 'warning'
    options.pure = ['Object.freeze']
  },
} satisfies Options

export default defineConfig({
  ...shared,
  entry: {
    index: 'src/index.ts',
    'internal/compiled': 'src/internal/compiled.ts',
  },
  dts: { entry: { index: 'src/index.ts', 'internal/compiled': 'src/internal/compiled.ts', 'internal/error-bag': 'src/internal/error-bag.ts' } },
  clean: true,
  // Bundled on its own, after the main build so its clean can't remove it: a page that only
  // shows errors must not share a module with pages that load the validator.
  async onSuccess() {
    await build({ ...shared, config: false, entry: { 'internal/error-bag': 'src/internal/error-bag.ts' }, splitting: false, clean: false, silent: true })
  },
})
