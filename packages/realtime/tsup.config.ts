import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/client.ts',
    server: 'src/server.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outExtension: () => ({ js: '.mjs' }),
  external: [
    '@holo-js/auth',
    '@holo-js/db',
    '@holo-js/validation',
  ],
})
