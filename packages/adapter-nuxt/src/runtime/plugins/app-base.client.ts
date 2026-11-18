import { defineNuxtPlugin, useRuntimeConfig } from '#app'

export default defineNuxtPlugin(() => {
  Object.assign(globalThis, { __HOLO_APP_BASE__: useRuntimeConfig().app.baseURL.replace(/\/+$/, '') })
})
