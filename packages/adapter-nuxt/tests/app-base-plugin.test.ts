import { afterEach, expect, it, vi } from 'vitest'
import { appPath } from '@holo-js/kernel/internal/app-base'

const runtimeConfig = vi.hoisted(() => ({ app: { baseURL: '/' } }))

vi.mock('#app', () => ({
  defineNuxtPlugin: (plugin: unknown) => plugin,
  useRuntimeConfig: () => runtimeConfig,
}))

afterEach(() => {
  Reflect.deleteProperty(globalThis, '__HOLO_APP_BASE__')
  vi.resetModules()
})

it.each([
  ['/dashboard/', '/dashboard/broadcasting/config'],
  ['/', '/broadcasting/config'],
])('serves Holo browser clients the runtime app.baseURL %s', async (baseURL, expected) => {
  runtimeConfig.app.baseURL = baseURL
  const { default: plugin } = await import('../src/runtime/plugins/app-base.client')
  plugin.setup()
  expect(appPath('/broadcasting/config')).toBe(expected)
})

it('runs before app plugins that enforce pre order', async () => {
  const { default: plugin } = await import('../src/runtime/plugins/app-base.client')
  expect(plugin.order).toBeLessThan(-20)
})
