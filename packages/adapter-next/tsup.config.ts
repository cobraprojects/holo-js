import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    config: 'src/config.ts',
    client: 'src/client.ts',
    'internal/use-form': 'src/use-form.ts',
    'internal/request-validation-flash': 'src/request-validation-flash.ts',
    'internal/request-validation-flash.browser': 'src/request-validation-flash.browser.ts',
    'internal/use-validation-errors': 'src/use-validation-errors.ts',
    realtime: 'src/realtime.ts',
    'validation-loader': 'src/validation-loader.ts',
    'route-loader': 'src/route-loader.ts',
    'server-action-loader': 'src/server-action-loader.ts',
    'realtime-definition-loader': 'src/realtime-definition-loader.ts',
    runtime: 'src/runtime.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  external: ['@holo-js/realtime', '@holo-js/realtime/client', '@holo-js/adapter-next/internal/use-form', '@holo-js/adapter-next/internal/request-validation-flash', '@holo-js/adapter-next/internal/use-validation-errors', 'react', 'next/headers.js', 'next/navigation.js'],
  esbuildOptions(options) {
    options.logLevel = 'warning'
  },
})
