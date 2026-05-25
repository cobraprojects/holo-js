import { afterEach, describe, expect, it, vi } from 'vitest'
import { field, schema } from '@holo-js/forms'

import { useForm } from '../src/client'
import { setPageForm } from './stubs/app-stores'

async function waitForActionHydration(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise<void>(resolve => queueMicrotask(() => resolve()))
}

describe('@holo-js/adapter-sveltekit client forms', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setPageForm(null)
  })

  it('hydrates matching SvelteKit page action failures without userland initialState wiring', async () => {
    vi.stubGlobal('window', {})
    const loginForm = schema({
      email: field.string().required().email(),
      password: field.password().required(),
    })

    setPageForm({
      ok: false,
      status: 422,
      valid: false,
      values: {
        email: 'bad-email',
      },
      errors: {
        email: ['Enter a valid email address.'],
      },
    })

    const login = useForm(loginForm, {
      initialValues: {
        email: '',
        password: '',
      },
    })

    await waitForActionHydration()

    expect(login.values.email).toBe('bad-email')
    expect(login.errors.first('email')).toBe('Enter a valid email address.')
  })

  it('ignores action failures that belong to a different schema', async () => {
    vi.stubGlobal('window', {})
    const loginForm = schema({
      email: field.string().required().email(),
      password: field.password().required(),
    })

    setPageForm({
      ok: false,
      status: 422,
      valid: false,
      values: {
        title: '',
      },
      errors: {
        title: ['Title is required.'],
      },
    })

    const login = useForm(loginForm, {
      initialValues: {
        email: '',
        password: '',
      },
    })

    await waitForActionHydration()

    expect(login.values.email).toBe('')
    expect(login.errors.has('title')).toBe(false)
  })
})
