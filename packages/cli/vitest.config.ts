import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const includeCliIntegration = process.env.HOLO_CLI_INCLUDE_INTEGRATION === '1'

export default defineConfig({
  resolve: {
    alias: [
      { find: '@holo-js/security/drivers/redis-adapter', replacement: resolve(__dirname, '../security/src/drivers/redis-adapter.ts') },
      { find: '@holo-js/session/drivers/redis-adapter', replacement: resolve(__dirname, '../session/src/drivers/redis-adapter.ts') },
      { find: '@holo-js/security', replacement: resolve(__dirname, '../security/src/index.ts') },
      { find: '@holo-js/auth', replacement: resolve(__dirname, '../auth/src/index.ts') },
      { find: '@holo-js/authorization', replacement: resolve(__dirname, '../authorization/src/index.ts') },
      { find: '@holo-js/auth-social', replacement: resolve(__dirname, '../auth-social/src/index.ts') },
      { find: '@holo-js/auth-workos', replacement: resolve(__dirname, '../auth-workos/src/index.ts') },
      { find: '@holo-js/auth-clerk', replacement: resolve(__dirname, '../auth-clerk/src/index.ts') },
      { find: '@holo-js/config', replacement: resolve(__dirname, '../config/src/index.ts') },
      { find: '@holo-js/core', replacement: resolve(__dirname, '../core/src/index.ts') },
      { find: '@holo-js/db', replacement: resolve(__dirname, '../db/src/index.ts') },
      { find: '@holo-js/db-mysql', replacement: resolve(__dirname, '../db-mysql/src/index.ts') },
      { find: '@holo-js/db-postgres', replacement: resolve(__dirname, '../db-postgres/src/index.ts') },
      { find: '@holo-js/db-sqlite', replacement: resolve(__dirname, '../db-sqlite/src/index.ts') },
      { find: '@holo-js/events', replacement: resolve(__dirname, '../events/src/index.ts') },
      { find: '@holo-js/queue', replacement: resolve(__dirname, '../queue/src/index.ts') },
      { find: '@holo-js/queue-redis', replacement: resolve(__dirname, '../queue-redis/src/index.ts') },
      { find: '@holo-js/queue-db', replacement: resolve(__dirname, '../queue-db/src/index.ts') },
      { find: '@holo-js/session', replacement: resolve(__dirname, '../session/src/index.ts') },
      { find: '@holo-js/storage-s3', replacement: resolve(__dirname, '../storage-s3/src/index.ts') },
      { find: '@holo-js/storage/runtime/drivers/s3', replacement: resolve(__dirname, '../storage/src/runtime/drivers/s3.ts') },
      { find: '@holo-js/storage/runtime', replacement: resolve(__dirname, '../storage/src/runtime/composables/index.ts') },
      { find: '@holo-js/storage', replacement: resolve(__dirname, '../storage/src/index.ts') },
    ],
  },
  test: {
    name: '@holo-js/cli',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: includeCliIntegration ? [] : ['tests/cli.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reportsDirectory: resolve(__dirname, '../../coverage/cli'),
      exclude: [
        'src/cli-types.ts',
        'src/**/types.ts',
        'src/bin/holo.ts',
        'src/bin/**',
        '**/src/bin/**',
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
