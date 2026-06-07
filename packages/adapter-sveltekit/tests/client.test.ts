import { afterEach, describe, expect, it, vi } from 'vitest'
import { field, schema } from '@holo-js/forms'
import type { RealtimeSubscriptionSnapshot } from '@holo-js/realtime'

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

  it('returns updated realtime query arrays by calling the query definition', async () => {
    vi.resetModules()
    vi.stubGlobal('window', {})

    type Post = { readonly id: number, readonly title: string }
    type PostSnapshot = RealtimeSubscriptionSnapshot<readonly Post[]>
    let realtimeListener: ((snapshot: PostSnapshot) => void) | undefined

    vi.doMock('svelte/reactivity', () => ({
      createSubscriber: (start: (update: () => void) => () => void) => {
        let cleanup: (() => void) | undefined
        return () => {
          cleanup ??= start(() => {})
          return cleanup
        }
      },
    }))

    const {
      configureRealtimeClientTransport,
      hydrateRealtimeQuery,
      resetRealtimeClientRuntime,
    } = await import('@holo-js/realtime/client')
    const { query } = await import('@holo-js/realtime')
    await import('../src/realtime')

    const listPosts = query({
      name: 'posts.list',
      access: 'public',
      handler: async () => [{ id: 1, title: 'First' }],
    })

    configureRealtimeClientTransport({
      async query<TResult>() {
        return {
          name: 'posts.list',
          data: [{ id: 1, title: 'First' }] as TResult,
          dependencies: [],
          version: 1,
        }
      },
      async mutate<TResult>() {
        return {
          name: 'posts.create',
          data: { created: true } as TResult,
          dependencies: [],
        }
      },
      subscribe<TResult>(_name: string, _args: Record<string, unknown>, listener: (snapshot: RealtimeSubscriptionSnapshot<TResult>) => void) {
        realtimeListener = snapshot => listener(snapshot as unknown as RealtimeSubscriptionSnapshot<TResult>)
        return () => {}
      },
    })
    hydrateRealtimeQuery(listPosts, {}, {
      name: 'posts.list',
      data: [{ id: 1, title: 'First' }],
      dependencies: [],
      version: 1,
    })

    const posts = listPosts()
    expect(Array.from(posts)).toEqual([{ id: 1, title: 'First' }])

    realtimeListener?.({
      name: 'posts.list',
      data: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
      dependencies: [],
      version: 2,
    })

    expect(Array.from(posts)).toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Second' },
    ])
    resetRealtimeClientRuntime()
  })

  it('updates realtime query objects when the first snapshot arrives after render', async () => {
    vi.resetModules()
    vi.stubGlobal('window', {})

    type Post = { readonly id: number, readonly title: string }
    type PostsData = { readonly posts: readonly Post[] }
    type PostsSnapshot = RealtimeSubscriptionSnapshot<PostsData>
    let realtimeListener: ((snapshot: PostsSnapshot) => void) | undefined

    vi.doMock('svelte/reactivity', () => ({
      createSubscriber: (start: (update: () => void) => () => void) => {
        let cleanup: (() => void) | undefined
        return () => {
          cleanup ??= start(() => {})
          return cleanup
        }
      },
    }))

    const {
      configureRealtimeClientTransport,
      resetRealtimeClientRuntime,
    } = await import('@holo-js/realtime/client')
    const { query } = await import('@holo-js/realtime')
    await import('../src/realtime')

    const listPosts = query({
      name: 'posts.object',
      access: 'public',
      handler: async () => ({ posts: [{ id: 1, title: 'First' }] }),
    })

    configureRealtimeClientTransport({
      async query<TResult>() {
        return {
          name: 'posts.object',
          data: { posts: [{ id: 1, title: 'First' }] } as TResult,
          dependencies: [],
          version: 1,
        }
      },
      async mutate<TResult>() {
        return {
          name: 'posts.update',
          data: { updated: true } as TResult,
          dependencies: [],
        }
      },
      subscribe<TResult>(_name: string, _args: Record<string, unknown>, listener: (snapshot: RealtimeSubscriptionSnapshot<TResult>) => void) {
        realtimeListener = snapshot => listener(snapshot as unknown as RealtimeSubscriptionSnapshot<TResult>)
        return () => {}
      },
    })

    const data = listPosts()
    void data.posts
    realtimeListener?.({
      name: 'posts.object',
      data: {
        posts: [
          { id: 1, title: 'First' },
          { id: 2, title: 'Second' },
        ],
      },
      dependencies: [],
      version: 2,
    })

    expect(data.posts).toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Second' },
    ])
    resetRealtimeClientRuntime()
  })

  it('defers realtime store subscriptions until reactive reads occur', async () => {
    vi.resetModules()
    vi.stubGlobal('window', {})

    type RealtimeRuntime = {
      useQuery<TDefinition>(definition: TDefinition, args: unknown): unknown
    }
    let runtime: RealtimeRuntime | undefined
    const store = {
      snapshot: {
        name: 'posts.list',
        data: [{ id: 1, title: 'First' }],
        dependencies: [],
        version: 1,
      },
      connect: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    }

    vi.doMock('svelte/reactivity', () => ({
      createSubscriber: (start: (update: () => void) => () => void) => {
        let cleanup: (() => void) | undefined
        return () => {
          cleanup ??= start(() => {})
          return cleanup
        }
      },
    }))
    vi.doMock('@holo-js/realtime/client', () => ({
      configureRealtimeClientRuntime(nextRuntime: RealtimeRuntime) {
        runtime = nextRuntime
      },
      configureRealtimeClientTransport: vi.fn(),
      createBroadcastRealtimeTransport: vi.fn(() => ({})),
      getRealtimeQueryStore: () => store,
    }))

    await import('../src/realtime')

    expect(runtime).toBeDefined()
    expect(runtime!.useQuery({ name: 'posts.list' }, {})).toBeDefined()
    expect(store.connect).toHaveBeenCalledTimes(1)
    expect(store.subscribe).not.toHaveBeenCalled()
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
    expect(setCookie).not.toHaveBeenCalled()
  })

  it('clears flashed validation errors only after browser consumption', async () => {
    const payload = {
      ok: false,
      status: 422,
      valid: false,
      bag: 'post',
      values: {
        title: 'Draft title',
        status: 'draft',
        tagIds: [1, 2],
      },
      errors: {
        title: ['This field must be at least 3 characters.'],
      },
    }
    const title = {
      name: 'title',
      value: '',
    }
    const status = {
      name: 'status',
      value: 'published',
    }
    const frameworkTag = {
      name: 'tagIds',
      type: 'checkbox',
      value: '1',
      checked: false,
    }
    const releaseTag = {
      name: 'tagIds',
      type: 'checkbox',
      value: '2',
      checked: false,
    }
    const image = {
      name: 'image',
      type: 'file',
      value: '',
    }
    const document = {
      cookie: `HOLO-SVELTEKIT-VALIDATION=${encodeURIComponent(JSON.stringify(payload))}`,
      querySelectorAll: () => [
        title,
        status,
        frameworkTag,
        releaseTag,
        image,
      ],
    }

    vi.stubGlobal('window', {
      location: {
        pathname: '/admin/posts/new',
      },
    })
    vi.stubGlobal('document', document)

    expect(useValidationErrors().has('title')).toBe(false)
    expect(document.cookie).toContain('HOLO-SVELTEKIT-VALIDATION=')

    const errors = useValidationErrors('post')

    expect(errors.first('title')).toBe('This field must be at least 3 characters.')
    expect(title.value).toBe('Draft title')
    expect(status.value).toBe('draft')
    expect(frameworkTag.checked).toBe(true)
    expect(releaseTag.checked).toBe(true)
    expect(image.value).toBe('')
    expect(document.cookie).toBe('HOLO-SVELTEKIT-VALIDATION=; Max-Age=0; Path=/admin/posts/new; SameSite=Lax')

    title.value = 'Existing post title'
    status.value = 'published'
    frameworkTag.checked = false
    releaseTag.checked = false

    await Promise.resolve()

    expect(title.value).toBe('Draft title')
    expect(status.value).toBe('draft')
    expect(frameworkTag.checked).toBe(true)
    expect(releaseTag.checked).toBe(true)
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

  it('returns a form failure when SvelteKit action failure data is invalid JSON', async () => {
    vi.stubGlobal('FormData', TestFormData)
    vi.stubGlobal('window', {
      location: {
        href: 'https://app.test/login',
      },
    })

    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response(JSON.stringify({
      type: 'failure',
      status: 500,
      data: 'not-json',
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    })))

    const loginForm = schema({
      email: field.string().required().email(),
      password: field.password().required(),
    })
    const login = useForm(loginForm, {
      initialValues: {
        email: 'ava@example.com',
        password: 'secret-password',
      },
    })

    const result = await login.submit()

    expect(result).toMatchObject({
      ok: false,
      status: 500,
      valid: false,
      errors: {
        _root: ['Unable to read the form response. Please try again.'],
      },
    })
    expect(login.errors.first('_root')).toBe('Unable to read the form response. Please try again.')
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
