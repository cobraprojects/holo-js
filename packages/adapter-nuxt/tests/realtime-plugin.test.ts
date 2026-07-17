import { describe, expect, it, vi } from 'vitest'

const defineNuxtPlugin = vi.fn((plugin: () => unknown) => plugin)
vi.mock('#app', () => ({ defineNuxtPlugin }))
vi.mock('../src/runtime/composables/realtime', () => ({}))

describe('Nuxt realtime plugin', () => {
  it('loads realtime composables through a Nuxt plugin entry', async () => {
    const plugin = (await import('../src/runtime/plugins/realtime')).default
    expect(plugin()).toBeUndefined()
    expect(defineNuxtPlugin).toHaveBeenCalledOnce()
  })
})
