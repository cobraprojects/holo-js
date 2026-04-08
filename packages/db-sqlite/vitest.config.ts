import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/db': resolve(__dirname, '../db/src/index.ts'),
    },
  },
  test: {
    name: '@holo-js/db-sqlite',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
