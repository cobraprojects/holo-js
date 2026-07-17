import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const runRedisIntegration = process.env.HOLO_REDIS_INTEGRATION === '1'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/kernel': resolve(__dirname, '../kernel/src/index.ts'),
      '@holo-js/cache': resolve(rootDir, '../cache/src/index.ts'),
      '@holo-js/config/registry': resolve(rootDir, '../config/src/registry.ts'),
      '@holo-js/config': resolve(rootDir, '../config/src/index.ts'),
      '@holo-js/media/config': resolve(rootDir, '../media/src/projectConfig.ts'),
      '@holo-js/media': resolve(rootDir, '../media/src/index.ts'),
    },
  },
  test: {
    name: '@holo-js/cache-redis',
    environment: 'node',
    include: runRedisIntegration
      ? ['tests/real-redis.test.ts']
      : ['tests/package.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
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
