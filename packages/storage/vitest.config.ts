import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@holo-js/kernel': resolve(__dirname, '../kernel/src/index.ts'),
      '@holo-js/config/registry': resolve(__dirname, '../config/src/registry.ts'),
      '@holo-js/config': resolve(__dirname, '../config/src/index.ts'),
      '@holo-js/media/config': resolve(__dirname, '../media/src/projectConfig.ts'),
      '@holo-js/media': resolve(__dirname, '../media/src/index.ts'),
      '@holo-js/db': resolve(__dirname, '../db/src/index.ts'),
      '@holo-js/storage-s3': resolve(__dirname, '../storage-s3/src/index.ts'),
    },
  },
  test: {
    name: '@holo-js/storage',
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
