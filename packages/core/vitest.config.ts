import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/config': resolve(__dirname, '../config/src/index.ts'),
      '@holo-js/db': resolve(__dirname, '../db/src/index.ts'),
      '@holo-js/events': resolve(__dirname, '../events/src/index.ts'),
      '@holo-js/queue': resolve(__dirname, '../queue/src/index.ts'),
      '@holo-js/queue-db': resolve(__dirname, '../queue-db/src/index.ts'),
      '@holo-js/storage/runtime/drivers/s3': resolve(__dirname, '../storage/src/runtime/drivers/s3.ts'),
      '@holo-js/storage/runtime': resolve(__dirname, '../storage/src/runtime/composables/index.ts'),
      '@holo-js/storage': resolve(__dirname, '../storage/src/index.ts'),
    },
  },
  test: {
    name: '@holo-js/core',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/types.ts',
        '**/*.d.ts',
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
