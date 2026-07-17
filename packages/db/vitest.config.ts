import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/config/registry': resolve(__dirname, '../config/src/registry.ts'),
      '@holo-js/config': resolve(__dirname, '../config/src/index.ts'),
      '@holo-js/media/config': resolve(__dirname, '../media/src/projectConfig.ts'),
      '@holo-js/media': resolve(__dirname, '../media/src/index.ts'),
      '@holo-js/kernel': resolve(__dirname, '../kernel/src/index.ts'),
      '@holo-js/db': resolve(__dirname, './src/index.ts'),
      '@holo-js/db-mysql': resolve(__dirname, '../db-mysql/src/index.ts'),
      '@holo-js/db-postgres': resolve(__dirname, '../db-postgres/src/index.ts'),
      '@holo-js/db-sqlite': resolve(__dirname, '../db-sqlite/src/index.ts'),
    },
  },
  test: {
    name: '@holo-js/db',
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/types.ts',
        'src/migrations/templates/**',
        'src/drivers/index.ts',
        '**/node_modules/**',
        'packages/core/**',
        'packages/storage/**',
        'packages/shared/**',
      ],
    },
  },
})
