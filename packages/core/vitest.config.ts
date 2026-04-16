import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/auth': resolve(__dirname, '../auth/src/index.ts'),
      '@holo-js/auth-social': resolve(__dirname, '../auth-social/src/index.ts'),
      '@holo-js/auth-social-google': resolve(__dirname, '../auth-social-google/src/index.ts'),
      '@holo-js/auth-social-github': resolve(__dirname, '../auth-social-github/src/index.ts'),
      '@holo-js/auth-social-discord': resolve(__dirname, '../auth-social-discord/src/index.ts'),
      '@holo-js/auth-social-facebook': resolve(__dirname, '../auth-social-facebook/src/index.ts'),
      '@holo-js/auth-social-apple': resolve(__dirname, '../auth-social-apple/src/index.ts'),
      '@holo-js/auth-social-linkedin': resolve(__dirname, '../auth-social-linkedin/src/index.ts'),
      '@holo-js/auth-workos': resolve(__dirname, '../auth-workos/src/index.ts'),
      '@holo-js/auth-clerk': resolve(__dirname, '../auth-clerk/src/index.ts'),
      '@holo-js/config': resolve(__dirname, '../config/src/index.ts'),
      '@holo-js/broadcast': resolve(__dirname, '../broadcast/src/index.ts'),
      '@holo-js/db': resolve(__dirname, '../db/src/index.ts'),
      '@holo-js/db-mysql': resolve(__dirname, '../db-mysql/src/index.ts'),
      '@holo-js/db-postgres': resolve(__dirname, '../db-postgres/src/index.ts'),
      '@holo-js/db-sqlite': resolve(__dirname, '../db-sqlite/src/index.ts'),
      '@holo-js/events': resolve(__dirname, '../events/src/index.ts'),
      '@holo-js/mail': resolve(__dirname, '../mail/src/index.ts'),
      '@holo-js/notifications': resolve(__dirname, '../notifications/src/index.ts'),
      '@holo-js/queue': resolve(__dirname, '../queue/src/index.ts'),
      '@holo-js/queue-redis': resolve(__dirname, '../queue-redis/src/index.ts'),
      '@holo-js/queue-db': resolve(__dirname, '../queue-db/src/index.ts'),
      '@holo-js/session': resolve(__dirname, '../session/src/index.ts'),
      '@holo-js/storage-s3': resolve(__dirname, '../storage-s3/src/index.ts'),
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
      reportsDirectory: resolve(__dirname, '../../coverage/core'),
      exclude: [
        'src/runtime/**/*.mjs',
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
