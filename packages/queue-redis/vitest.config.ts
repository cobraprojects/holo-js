import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/queue': resolve(__dirname, '../queue/src/index.ts'),
    },
  },
  test: {
    name: '@holo-js/queue-redis',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
