import { defineConfig, mergeConfig } from 'vitest/config'
import { workspaceTestConfig } from '../../vitest.shared.ts'

export default mergeConfig(workspaceTestConfig, defineConfig({
  test: {
    name: '@holo-js/db-mysql',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
}))
