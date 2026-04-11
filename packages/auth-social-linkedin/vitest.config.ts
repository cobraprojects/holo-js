import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/auth': resolve(import.meta.dirname, '../auth/src/index.ts'),
      '@holo-js/auth-social': resolve(import.meta.dirname, '../auth-social/src/index.ts'),
      '@holo-js/config': resolve(import.meta.dirname, '../config/src/index.ts'),
    },
  },
  test: {
    name: '@holo-js/auth-social-linkedin',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
