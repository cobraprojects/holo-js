import adapter from '@sveltejs/adapter-node'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'
import { withHoloSvelteKit } from '@holo-js/adapter-sveltekit/config'

/** @type {import('@sveltejs/kit').Config} */
const config = withHoloSvelteKit({
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
  },
})

export default config
