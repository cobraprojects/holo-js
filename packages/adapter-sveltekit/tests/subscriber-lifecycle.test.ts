import { describe, expect, it, vi } from 'vitest'
import { field, schema } from '@holo-js/forms'

describe('SvelteKit form subscriber lifecycle', () => {
  it('subscribes and disposes form registration through the Svelte subscriber', async () => {
    vi.resetModules()
    const cleanup = vi.fn()
    vi.doMock('svelte/reactivity', () => ({
      createSubscriber: (start: (update: () => void) => () => void) => () => {
        const dispose = start(() => {})
        dispose()
        cleanup()
      },
    }))
    vi.stubGlobal('window', {})
    const { useForm } = await import('../src/client')
    const form = useForm(schema({ title: field.string() }), {
      submitter: async ({ values }) => ({ ok: true, status: 200, data: values }),
    })
    void form.values
    expect(cleanup).toHaveBeenCalled()
    vi.doUnmock('svelte/reactivity')
    vi.unstubAllGlobals()
  })
})
