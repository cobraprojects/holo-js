export default defineNuxtConfig({
  devtools: { enabled: true },
  compatibilityDate: '2024-11-01',
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
