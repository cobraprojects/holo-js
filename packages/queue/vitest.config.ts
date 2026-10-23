import { defineConfig, mergeConfig } from 'vitest/config'
import { workspaceTestConfig } from '../../vitest.shared.ts'

export default mergeConfig(workspaceTestConfig, defineConfig({
  test: {
    name: '@holo-js/queue',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      excludeAfterRemap: true,
      exclude: [
        'src/**/types.ts',
        '**/node_modules/**',
      ],
    },
  },
}))
