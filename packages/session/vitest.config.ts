import { defineConfig, mergeConfig } from 'vitest/config'
import { workspaceTestConfig } from '../../vitest.shared'

export default mergeConfig(workspaceTestConfig, defineConfig({
  test: {
    name: '@holo-js/session',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        '**/node_modules/**',
      ],
    },
  },
}))
