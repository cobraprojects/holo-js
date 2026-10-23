import { resolve } from 'node:path'
import { defineConfig, mergeConfig } from 'vitest/config'
import { workspaceTestConfig } from '../../vitest.shared.ts'

export default mergeConfig(workspaceTestConfig, defineConfig({
  test: {
    name: '@holo-js/core',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reportsDirectory: resolve(__dirname, '../../coverage/core'),
      exclude: [
        'src/runtime/**/*.mjs',
        'src/**/types.ts',
        '**/*.d.ts',
        '**/node_modules/**',
      ],
    },
  },
}))
