import { resolve } from 'node:path'
import { defineConfig, mergeConfig } from 'vitest/config'
import { workspaceTestConfig } from '../../vitest.shared.ts'

export default mergeConfig(workspaceTestConfig, defineConfig({
  resolve: {
    alias: {
      '#app': resolve(__dirname, 'tests/fixtures/nuxt-app.ts'),
      '#imports': resolve(__dirname, 'tests/fixtures/nitro-imports.ts'),
    },
  },
  test: {
    name: '@holo-js/adapter-nuxt',
    environment: 'node',
    env: { APP_ENV: 'test' },
    include: ['tests/**/*.test.ts'],
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/types.ts',
        'src/**/*.d.ts',
        'src/**/shims.d.ts',
        '**/node_modules/**',
      ],
    },
  },
}))
