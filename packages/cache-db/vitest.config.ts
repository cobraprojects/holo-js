import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/kernel': resolve(__dirname, '../kernel/src/index.ts'),
      '@holo-js/cache': resolve(__dirname, '../cache/src/index.ts'),
      '@holo-js/config/registry': resolve(__dirname, '../config/src/registry.ts'),
      '@holo-js/config': resolve(__dirname, '../config/src/index.ts'),
      '@holo-js/media/config': resolve(__dirname, '../media/src/projectConfig.ts'),
      '@holo-js/media': resolve(__dirname, '../media/src/index.ts'),
      '@holo-js/db': resolve(__dirname, '../db/src/index.ts'),
      '@holo-js/db-sqlite': resolve(__dirname, '../db-sqlite/src/index.ts'),
    },
  },
  test: {
    name: '@holo-js/cache-db',
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
