import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/auth': fileURLToPath(new URL('../auth/src/index.ts', import.meta.url)),
      '@holo-js/db': fileURLToPath(new URL('../db/src/index.ts', import.meta.url)),
      '@holo-js/db-sqlite': fileURLToPath(new URL('../db-sqlite/src/index.ts', import.meta.url)),
      '@holo-js/validation': fileURLToPath(new URL('../validation/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: '@holo-js/realtime',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
