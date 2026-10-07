import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/adapter-shared/next/request-context': resolve(__dirname, '../adapter-shared/src/next/request-context.node.ts'),
      '@holo-js/kernel': resolve(__dirname, '../kernel/src/index.ts'),
    },
  },
  test: {
    name: '@holo-js/auth',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        '**/node_modules/**',
      ],
    },
  },
})
