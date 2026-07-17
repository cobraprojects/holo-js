import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/config/registry': resolve(__dirname, 'src/registry.ts'),
      '@holo-js/config': resolve(__dirname, 'src/index.ts'),
      '@holo-js/kernel': resolve(__dirname, '../kernel/src/index.ts'),
      '@holo-js/queue/config': resolve(__dirname, '../queue/src/config.ts'),
      '@holo-js/queue': resolve(__dirname, '../queue/src/index.ts'),
      '@holo-js/storage/config': resolve(__dirname, '../storage/src/config.ts'),
      '@holo-js/storage': resolve(__dirname, '../storage/src/index.ts'),
      '@holo-js/auth/config': resolve(__dirname, '../auth/src/config.ts'),
      '@holo-js/auth': resolve(__dirname, '../auth/src/index.ts'),
      '@holo-js/broadcast/config': resolve(__dirname, '../broadcast/src/config.ts'),
      '@holo-js/broadcast': resolve(__dirname, '../broadcast/src/index.ts'),
      '@holo-js/cache/config': resolve(__dirname, '../cache/src/config.ts'),
      '@holo-js/cache': resolve(__dirname, '../cache/src/index.ts'),
      '@holo-js/db/config': resolve(__dirname, '../db/src/databaseConfig.ts'),
      '@holo-js/db': resolve(__dirname, '../db/src/index.ts'),
      '@holo-js/mail/config': resolve(__dirname, '../mail/src/config.ts'),
      '@holo-js/mail': resolve(__dirname, '../mail/src/index.ts'),
      '@holo-js/media/config': resolve(__dirname, '../media/src/projectConfig.ts'),
      '@holo-js/media': resolve(__dirname, '../media/src/index.ts'),
      '@holo-js/notifications/config': resolve(__dirname, '../notifications/src/config.ts'),
      '@holo-js/notifications': resolve(__dirname, '../notifications/src/index.ts'),
      '@holo-js/security/config': resolve(__dirname, '../security/src/config.ts'),
      '@holo-js/security': resolve(__dirname, '../security/src/index.ts'),
      '@holo-js/session/config': resolve(__dirname, '../session/src/config.ts'),
      '@holo-js/session': resolve(__dirname, '../session/src/index.ts'),
    },
  },
  test: {
    name: '@holo-js/config',
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
