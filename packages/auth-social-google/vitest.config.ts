import { defineConfig, mergeConfig } from 'vitest/config'
import { workspaceTestConfig } from '../../vitest.shared.ts'

export default mergeConfig(workspaceTestConfig, defineConfig({
  test: {
    name: '@holo-js/auth-social-google',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
}))
