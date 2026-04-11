import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/auth': resolve(__dirname, '../auth/src/index.ts'),
      '@holo-js/auth-social': resolve(__dirname, '../auth-social/src/index.ts'),
      '@holo-js/auth-workos': resolve(__dirname, '../auth-workos/src/index.ts'),
      '@holo-js/auth-clerk': resolve(__dirname, '../auth-clerk/src/index.ts'),
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
      '@holo-js/session': resolve(__dirname, '../session/src/index.ts'),
      '@holo-js/validation': resolve(__dirname, '../validation/src/index.ts'),
    },
  },
  test: {
    name: '@holo-js/adapter-sveltekit',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/types.ts',
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
