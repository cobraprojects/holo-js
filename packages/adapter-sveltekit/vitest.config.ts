import { defineConfig, mergeConfig } from 'vitest/config'
import { workspaceTestConfig } from '../../vitest.shared'

export default mergeConfig(workspaceTestConfig, defineConfig({
  test: {
    name: '@holo-js/adapter-sveltekit',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/types.ts',
        '**/node_modules/**',
      ],
    },
  },
}))
