import { defineConfig, mergeConfig } from 'vitest/config'
import { workspaceTestConfig } from '../../vitest.shared.ts'

export default mergeConfig(workspaceTestConfig, defineConfig({
  test: {
    name: '@holo-js/storage-s3',
    include: ['tests/**/*.test.ts'],
  },
}))
