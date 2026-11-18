import { defineNuxtPlugin, useRuntimeConfig } from '#app'

export default defineNuxtPlugin({
  name: 'holo-app-base',
  order: -30,
  setup() {
    Object.assign(globalThis, { __HOLO_APP_BASE__: useRuntimeConfig().app.baseURL.replace(/\/+$/, '') })
  },
})
