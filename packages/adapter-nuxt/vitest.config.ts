import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/core/runtime': resolve(__dirname, '../core/src/portable/index.ts'),
      '@holo-js/storage/runtime/drivers/s3': resolve(__dirname, '../storage/src/runtime/drivers/s3.ts'),
      '@holo-js/storage/runtime': resolve(__dirname, '../storage/src/runtime/composables/index.ts'),
      '@holo-js/config': resolve(__dirname, '../config/src/index.ts'),
      '@holo-js/core': resolve(__dirname, '../core/src/index.ts'),
      '@holo-js/db': resolve(__dirname, '../db/src/index.ts'),
      '@holo-js/db-mysql': resolve(__dirname, '../db-mysql/src/index.ts'),
      '@holo-js/db-postgres': resolve(__dirname, '../db-postgres/src/index.ts'),
      '@holo-js/db-sqlite': resolve(__dirname, '../db-sqlite/src/index.ts'),
      '@holo-js/forms/client': resolve(__dirname, '../forms/src/client.ts'),
      '@holo-js/forms': resolve(__dirname, '../forms/src/index.ts'),
      '@holo-js/queue': resolve(__dirname, '../queue/src/index.ts'),
      '@holo-js/queue-redis': resolve(__dirname, '../queue-redis/src/index.ts'),
      '@holo-js/queue-db': resolve(__dirname, '../queue-db/src/index.ts'),
      '@holo-js/storage': resolve(__dirname, '../storage/src/index.ts'),
      '@holo-js/storage-s3': resolve(__dirname, '../storage-s3/src/index.ts'),
      '@holo-js/validation': resolve(__dirname, '../validation/src/index.ts'),
    },
  },
  test: {
    name: '@holo-js/adapter-nuxt',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/types.ts',
        'src/**/*.d.ts',
        'src/**/shims.d.ts',
        '**/node_modules/**',
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
