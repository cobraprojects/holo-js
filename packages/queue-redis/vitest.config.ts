import { defineConfig, mergeConfig } from 'vitest/config'
import { workspaceTestConfig } from '../../vitest.shared'

export default mergeConfig(workspaceTestConfig, defineConfig({
  test: {
    name: '@holo-js/queue-redis',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
}))
