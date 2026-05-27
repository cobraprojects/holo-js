import { afterEach, describe, expect, it, vi } from 'vitest'
import { field, schema } from '@holo-js/forms'

vi.mock('$app/stores', async () => await import('./stubs/app-stores'))

import { useForm, useValidationErrors } from '../src/client'
import { setPageForm } from './stubs/app-stores'

class TestFormData {
  readonly #entries: Array<[string, string]> = []
  readonly form?: TestFormElement

  constructor(form?: TestFormElement) {
    this.form = form
    for (const control of form?.controls ?? []) {
      if (control.type === 'checkbox' && !control.checked) {
        continue
      }

      this.append(control.name, control.value)
    }
  }

  append(name: string, value: string): void {
    this.#entries.push([name, value])
  }

  set(name: string, value: string): void {
    const index = this.#entries.findIndex(entry => entry[0] === name)
    if (index === -1) {
      this.append(name, value)
      return
    }

    this.#entries.splice(index, 1, [name, value])
  }

  * entries(): IterableIterator<[string, string]> {
    yield * this.#entries
  }
}

type TestFormControl = {
  readonly name: string
  readonly value: string
  readonly type?: string
  readonly checked?: boolean
}

type TestFormElement = {
  readonly tagName: string
  readonly method: string
  readonly action: string
  readonly controls: readonly TestFormControl[]
}

type TestSubmitEvent = {
  readonly target: TestFormElement
  preventDefault(): void
  stopImmediatePropagation(): void
}

async function waitForActionHydration(predicate: () => boolean): Promise<void> {
  const attempts = 20
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 120))
    await new Promise<void>(resolve => queueMicrotask(() => resolve()))

    if (predicate()) {
      return
    }
  }

  throw new Error(`waitForActionHydration: predicate not satisfied after ${attempts} attempts.`)
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

    await waitForActionHydration(() => login.values.email === 'bad-email')

    expect(login.values.email).toBe('bad-email')
    expect(login.errors.first('email')).toBe('Enter a valid email address.')
  })

  it('hydrates flashed SvelteKit validation failures during SSR', () => {
    const setCookie = vi.fn()
    const loginForm = schema({
      email: field.string().required().email(),
      password: field.password().required(),
    })
    const payload = {
      ok: false,
      status: 422,
      valid: false,
      values: {
        email: 'bad-email',
      },
      errors: {
        email: ['Enter a valid email address.'],
      },
    }

    vi.stubGlobal('__holoSvelteKitRequestEventStore', {
      getStore: () => ({
        url: new URL('https://app.test/login'),
        cookies: {
          get: (name: string) => name === 'HOLO-SVELTEKIT-VALIDATION'
            ? encodeURIComponent(JSON.stringify(payload))
            : undefined,
          set: setCookie,
        },
      }),
    })

    const login = useForm(loginForm, {
      initialValues: {
        email: '',
        password: '',
      },
    })

    expect(login.values.email).toBe('bad-email')
    expect(login.errors.first('email')).toBe('Enter a valid email address.')
    expect(setCookie).toHaveBeenCalledWith('HOLO-SVELTEKIT-VALIDATION', '', {
      path: '/login',
      maxAge: 0,
      sameSite: 'lax',
      httpOnly: true,
    })
  })

  it('reads flashed validation errors from the default and named bags during SSR', () => {
    const setCookie = vi.fn()
    const payload = {
      ok: false,
      status: 422,
      valid: false,
      bag: 'post',
      values: {},
      errors: {
        title: ['This field must be at least 3 characters.'],
      },
    }

    vi.stubGlobal('__holoSvelteKitRequestEventStore', {
      getStore: () => ({
        url: new URL('https://app.test/admin/posts/2/edit'),
        cookies: {
          get: (name: string) => name === 'HOLO-SVELTEKIT-VALIDATION'
            ? encodeURIComponent(JSON.stringify(payload))
            : undefined,
          set: setCookie,
        },
      }),
    })

    const defaultBag = useValidationErrors()
    const postBag = useValidationErrors('post')

    expect(defaultBag.has('title')).toBe(false)
    expect(postBag.first('title')).toBe('This field must be at least 3 characters.')
    expect(setCookie).toHaveBeenCalledWith('HOLO-SVELTEKIT-VALIDATION', '', {
      path: '/admin/posts/2/edit',
      maxAge: 0,
      sameSite: 'lax',
      httpOnly: true,
    })
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

    await waitForActionHydration(() => login.values.email === '')

    expect(login.values.email).toBe('')
    expect(login.errors.has('title')).toBe(false)
  })

  it('submits explicit SvelteKit form clients through the action JSON path and applies validation failures', async () => {
    const assign = vi.fn()
    vi.stubGlobal('FormData', TestFormData)
    vi.stubGlobal('window', {
      location: {
        href: 'https://app.test/login',
        assign,
      },
    })

    const fetch = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => new Response(JSON.stringify({
      type: 'failure',
      status: 422,
      data: JSON.stringify({
        ok: false,
        status: 422,
        valid: false,
        values: {
          email: 'bad@app.test',
        },
        errors: {
          email: ['These credentials do not match our records.'],
        },
      }),
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-holo-validation-flash': '1',
      },
    }))
    vi.stubGlobal('fetch', fetch)

    const loginForm = schema({
      email: field.string().required().email(),
      password: field.password().required(),
      remember: field.boolean(),
    })
    const login = useForm(loginForm, {
      initialValues: {
        email: '',
        password: '',
        remember: false,
      },
    })
    await login.fields.email.set('bad@app.test')
    await login.fields.password.set('secret-password')
    await login.fields.remember.set(true)

    await login.submit()

    expect(fetch).toHaveBeenCalledWith('https://app.test/login', {
      method: 'POST',
      credentials: 'same-origin',
      body: expect.any(TestFormData),
      headers: {
        accept: 'application/json',
        'x-sveltekit-action': 'true',
      },
    })
    expect(login.values.email).toBe('bad@app.test')
    expect(login.errors.first('email')).toBe('These credentials do not match our records.')
    expect(assign).not.toHaveBeenCalled()
  })

  it('owns matching browser form submits and applies action validation failures to form errors', async () => {
    let submitListener: ((event: TestSubmitEvent) => void) | undefined
    const preventDefault = vi.fn()
    const stopImmediatePropagation = vi.fn()
    const assign = vi.fn()
    vi.stubGlobal('FormData', TestFormData)
    vi.stubGlobal('document', {
      addEventListener(type: string, listener: (event: TestSubmitEvent) => void) {
        if (type === 'submit') {
          submitListener = listener
        }
      },
    })
    vi.stubGlobal('window', {
      location: {
        href: 'https://app.test/login',
        assign,
      },
    })

    const fetch = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      expect((init?.body as TestFormData | undefined)?.form).toBe(loginElement)
      return new Response(JSON.stringify({
        type: 'failure',
        status: 422,
        data: JSON.stringify({
          ok: false,
          status: 422,
          valid: false,
          values: {
            email: 'missing@app.test',
          },
          errors: {
            email: ['These credentials do not match our records.'],
            password: ['These credentials do not match our records.'],
          },
        }),
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      })
    })
    vi.stubGlobal('fetch', fetch)

    const loginElement: TestFormElement = {
      tagName: 'FORM',
      method: 'post',
      action: 'https://app.test/login',
      controls: [
        { name: 'email', value: 'missing@app.test' },
        { name: 'password', value: 'wrong-password' },
      ],
    }
    const loginForm = schema({
      email: field.string().required().email(),
      password: field.password().required(),
    })
    const login = useForm(loginForm, {
      initialValues: {
        email: '',
        password: '',
      },
    })

    submitListener?.({
      target: loginElement,
      preventDefault,
      stopImmediatePropagation,
    })

    await vi.waitFor(() => {
      expect(login.errors.first('email')).toBe('These credentials do not match our records.')
    })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopImmediatePropagation).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith('https://app.test/login', {
      method: 'POST',
      credentials: 'same-origin',
      body: expect.any(TestFormData),
      headers: {
        accept: 'application/json',
        'x-sveltekit-action': 'true',
      },
    })
    expect(login.values.email).toBe('missing@app.test')
    expect(login.errors.first('password')).toBe('These credentials do not match our records.')
    expect(assign).not.toHaveBeenCalled()
  })
})
