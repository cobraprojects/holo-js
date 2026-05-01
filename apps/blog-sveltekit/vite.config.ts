import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    fs: {
      allow: ['.holo-js/generated'],
    },
  },
  ssr: {
    external: [
      '@holo-js/adapter-sveltekit',
      '@holo-js/config',
      '@holo-js/core',
      '@holo-js/db',
      '@holo-js/storage',
      '@holo-js/storage/runtime',
      'better-sqlite3',
    ],
  },
})
