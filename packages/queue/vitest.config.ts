import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/config': resolve(__dirname, '../config/src/index.ts'),
      '@holo-js/queue-redis': resolve(__dirname, '../queue-redis/src/index.ts'),
    },
  },
  test: {
    name: '@holo-js/queue',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      excludeAfterRemap: true,
      exclude: [
        'src/**/types.ts',
        '../queue-redis/**',
        '../queue-redis/src/**',
        '**/packages/queue-redis/**',
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
