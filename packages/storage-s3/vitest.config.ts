import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@holo-js/storage-s3',
    include: ['tests/**/*.test.ts'],
  },
})
