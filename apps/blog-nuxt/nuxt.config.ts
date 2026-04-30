export default defineNuxtConfig({
  modules: ['@holo-js/adapter-nuxt'],
  sourcemap: {
    client: false,
    server: false,
  },
  vite: {
    build: {
      rollupOptions: {
        onwarn(warning, defaultHandler) {
          if (
            warning.message.includes('nuxt:module-preload-polyfill')
            && warning.message.includes('didn\'t generate a sourcemap')
          ) {
            return
          }

          defaultHandler(warning)
        },
      },
    },
  },
})
