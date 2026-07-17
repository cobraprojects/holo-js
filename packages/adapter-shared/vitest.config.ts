import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/kernel/http-errors': resolve(__dirname, '../kernel/src/httpErrors.ts'),
      '@holo-js/kernel': resolve(__dirname, '../kernel/src/index.ts'),
    },
  },
  test: {
    name: '@holo-js/adapter-shared',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
