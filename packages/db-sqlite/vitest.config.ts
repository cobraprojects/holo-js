import { defineConfig, mergeConfig } from 'vitest/config'
import { workspaceTestConfig } from '../../vitest.shared'

export default mergeConfig(workspaceTestConfig, defineConfig({
  test: {
    name: '@holo-js/db-sqlite',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
}))
