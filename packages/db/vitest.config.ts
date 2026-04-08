import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
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
        'src/drivers/SQLiteAdapter.ts',
        'src/drivers/PostgresAdapter.ts',
        'src/drivers/MySQLAdapter.ts',
        '**/node_modules/**',
        'packages/core/**',
        'packages/storage/**',
        'packages/shared/**',
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
