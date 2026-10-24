import { afterEach, describe, expect, it, vi } from 'vitest'
import { field, schema } from '@holo-js/validation'
import { svelteClientInternals } from '../src/client'

const pageState = vi.hoisted(() => ({ form: undefined as unknown }))

vi.mock('$app/state', () => ({ page: pageState }))

const loginSchema = schema({ email: field.string().required() })

const serverFailure = {
  ok: false,
  status: 422,
  valid: false,
  message: 'Invalid input.',
  bag: 'default',
  values: { email: 'ava@example.com' },
  errors: { email: ['Invalid email.'] },
}

function withBrowserWindow(run: () => Promise<void>): Promise<void> {
  const globalWithWindow = globalThis as { window?: unknown }
  const previous = globalWithWindow.window
  globalWithWindow.window = {}
  return run().finally(() => {
    globalWithWindow.window = previous
  })
}

afterEach(() => {
  pageState.form = undefined
})

describe('client page state hydration', () => {
  it('applies the server form state read from $app/state in the browser', async () => {
    pageState.form = serverFailure

    await withBrowserWindow(async () => {
      const applyServerState = vi.fn()
      await svelteClientInternals.hydrateActionFormState({ applyServerState } as never, loginSchema)

      expect(applyServerState).toHaveBeenCalledWith(expect.objectContaining({
        status: 422,
        values: { email: 'ava@example.com' },
      }))
    })
  })

  it('does nothing when the page carries no form state', async () => {
    pageState.form = undefined

    await withBrowserWindow(async () => {
      const applyServerState = vi.fn()
      await svelteClientInternals.hydrateActionFormState({ applyServerState } as never, loginSchema)

      expect(applyServerState).not.toHaveBeenCalled()
    })
  })

  it('does nothing outside the browser', async () => {
    pageState.form = serverFailure
    const applyServerState = vi.fn()

    await svelteClientInternals.hydrateActionFormState({ applyServerState } as never, loginSchema)

    expect(applyServerState).not.toHaveBeenCalled()
  })
})
