import { resolve } from 'node:path'
import { defineConfig, mergeConfig } from 'vitest/config'
import { workspaceTestConfig } from '../../vitest.shared'

const includeCliIntegration = process.env.HOLO_CLI_INCLUDE_INTEGRATION === '1'

export default mergeConfig(workspaceTestConfig, defineConfig({
  test: {
    name: '@holo-js/cli',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    maxWorkers: 2,
    testTimeout: includeCliIntegration ? 30_000 : 5_000,
    exclude: includeCliIntegration ? [] : ['tests/cli.test.ts'],
    ...(includeCliIntegration ? { globalSetup: ['tests/global-setup.ts'] } : {}),
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reportsDirectory: resolve(__dirname, '../../coverage/cli'),
      exclude: [
        'src/cli-types.ts',
        'src/**/types.ts',
        'src/bin/holo.ts',
        'src/bin/**',
        '**/src/bin/**',
        '**/node_modules/**',
      ],
    },
  },
}))
