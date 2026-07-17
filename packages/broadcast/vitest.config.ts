import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/kernel': resolve(__dirname, '../kernel/src/index.ts'),
      '@holo-js/validation': fileURLToPath(new URL('../validation/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: '@holo-js/broadcast',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/types.ts',
        '**/node_modules/**',
      ],
    },
  },
})
