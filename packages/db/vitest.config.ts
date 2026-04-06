import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@holo-js/db',
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/types.ts',
        'src/migrations/templates/**',
        '**/node_modules/**',
        'packages/core/**',
        'packages/storage/**',
        'packages/shared/**',
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
