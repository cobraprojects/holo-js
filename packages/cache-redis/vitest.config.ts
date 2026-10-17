import { defineConfig, mergeConfig } from 'vitest/config'
import { workspaceTestConfig } from '../../vitest.shared'

const runRedisIntegration = process.env.HOLO_REDIS_INTEGRATION === '1'

export default mergeConfig(workspaceTestConfig, defineConfig({
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
    },
  },
}))
