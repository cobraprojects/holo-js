import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/cache': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      '@holo-js/cache-db': fileURLToPath(new URL('../cache-db/src/index.ts', import.meta.url)),
      '@holo-js/db': fileURLToPath(new URL('../db/src/index.ts', import.meta.url)),
      '@holo-js/config': fileURLToPath(new URL('../config/src/index.ts', import.meta.url)),
      '@holo-js/cache-redis': fileURLToPath(new URL('../cache-redis/src/index.ts', import.meta.url)),
      ioredis: fileURLToPath(new URL('./tests/support/ioredis-stub.ts', import.meta.url)),
    },
  },
  test: {
    name: '@holo-js/cache',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/types.ts',
        'src/**/*.d.ts',
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
