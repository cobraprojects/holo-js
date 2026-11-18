import type { RequestEvent } from '@sveltejs/kit'
import { afterEach, describe, expect, it } from 'vitest'
import { ValidationException, field, schema, validate } from '@holo-js/validation'
import { InvalidCursorException } from '../../db/src/core/errors'
import { adapterSvelteKitInternals, createSvelteKitHoloHooks } from '../src'

function createEvent(value: string, accept = 'application/json', path = '/login', options: { readonly method?: string, readonly routeId?: string, readonly params?: Record<string, string> } = {}) {
  const flashed = new Map<string, string>()
  const method = options.method ?? 'POST'
  const event: Partial<RequestEvent> = {
    url: new URL(`https://app.test${path}`),
    ...(options.routeId === undefined ? {} : { route: { id: options.routeId } as RequestEvent['route'], params: options.params ?? {} }),
    request: new Request(`https://app.test${path}`, {
      method,
      headers: { accept },
      ...(method === 'POST' ? { body: new URLSearchParams({ email: value, password: 'private-password' }) } : {}),
    }),
    cookies: {
      get: (name: string) => flashed.get(name),
      getAll: () => [...flashed].map(([name, value]) => ({ name, value })),
      delete: (name: string) => { flashed.delete(name) },
      serialize: (name: string, value: string) => `${name}=${value}`,
      set: (name: string, value: string) => { flashed.set(name, value) },
    } as unknown as RequestEvent['cookies'],
  }
  return { event: event as RequestEvent, flashed }
}

const loginSchema = schema({ email: field.string().required().email(), password: field.string().required().min(20) })

describe('SvelteKit validation hooks', () => {
  it('isolates concurrent submissions at the same URL across tracing clones', async () => {
    const first = createEvent('first-invalid')
    const second = createEvent('second-invalid')
    let releaseFirst: () => void = () => {}
    const waiting = new Promise<void>((resolve) => { releaseFirst = resolve })
    const hooks = createSvelteKitHoloHooks({ handle: ({ event, resolve }) => resolve(event) })
    const submit = (event: RequestEvent) => hooks.handle({ event, resolve: async (event) => {
      try {
        await validate(await event.request.formData(), loginSchema)
        return new Response('success')
      } catch (error) {
        await hooks.handleError({ event: { ...event }, kind: 'unknown', error })
        if (event === first.event) await waiting
        else releaseFirst()
        return new Response('framework error', { status: 500 })
      }
    } })
    const [firstResponse, secondResponse] = await Promise.all([submit(first.event), submit(second.event)])
    for (const [response, value] of [[firstResponse, 'first-invalid'], [secondResponse, 'second-invalid']] as const) {
      expect(response.status).toBe(200)
      const action = await response.json() as { type: string, status: number, data: string }
      expect(action.type).toBe('failure')
      expect(action.status).toBe(422)
      expect(JSON.parse(action.data)).toMatchObject({ values: { email: value } })
      expect(action.data).not.toContain('private-password')
    }
  })
  it('preserves browser redirects and filters sensitive flashed values', async () => {
    (adapterSvelteKitInternals.getState() as { project?: unknown }).project = { config: { app: { key: 'hooks-test-app-key', debug: false } } }
    const { event, flashed } = createEvent('invalid-email', 'text/html', '/login?/submit')
    const hooks = createSvelteKitHoloHooks({ handle: ({ event, resolve }) => resolve(event) })
    const response = await hooks.handle({ event, resolve: async (event) => {
      try {
        await validate(await event.request.formData(), loginSchema)
      } catch (error) {
        await hooks.handleError({ event: { ...event }, kind: 'unknown', error })
      }
      return new Response('native failure', { status: 500 })
    } })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/login')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const cookie = flashed.get('HOLO-SVELTEKIT-VALIDATION')
    expect(cookie).toBeDefined()
    expect(adapterSvelteKitInternals.readValidationFlashCookie(cookie)).toMatchObject({ values: { email: 'invalid-email' } })
    expect(cookie ?? '').not.toContain('invalid-email')
    expect(response.headers.get('set-cookie')).toContain('HOLO-SVELTEKIT-VALIDATION=')
  })

  it('retains API status and validation payload through native errors', async () => {
    const { event } = createEvent('invalid-email', 'application/json', '/api/login')
    const hooks = createSvelteKitHoloHooks({ handle: ({ event, resolve }) => resolve(event) })
    const response = await hooks.handle({ event, resolve: async (event) => {
      await validate(await event.request.formData(), loginSchema)
      return new Response('success')
    } })
    expect(response.status).toBe(422)
    const body = await response.text()
    expect(JSON.parse(body)).toMatchObject({ valid: false, status: 422, values: { email: 'invalid-email' } })
    expect(body).not.toContain('private-password')
  })

  it('answers an invalid pagination cursor reported through native errors with a 422 on the cursor key', async () => {
    (adapterSvelteKitInternals.getState() as { project?: unknown }).project = { config: { app: { key: 'hooks-test-app-key', debug: false } } }
    const { event, flashed } = createEvent('ignored', 'application/json', '/api/posts')
    const hooks = createSvelteKitHoloHooks({ handle: ({ event, resolve }) => resolve(event) })
    const response = await hooks.handle({ event, resolve: async (event) => {
      await hooks.handleError({ event, kind: 'unknown', error: new InvalidCursorException('after', 'Reload the feed.') })
      return new Response('native failure', { status: 500 })
    } })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ status: 422, message: 'Reload the feed.', errors: { after: ['Reload the feed.'] } })
    expect(flashed.size).toBe(0)
  })

  it.each([
    ['an API route under the base path', '/dashboard/api/login', '/api/login'],
    ['an API route inside a route group', '/dashboard/api/login', '/(app)/api/login'],
  ])('answers validation failures on %s with 422 JSON and no flash cookie', async (_label, path, routeId) => {
    (adapterSvelteKitInternals.getState() as { project?: unknown }).project = { config: { app: { key: 'hooks-test-app-key', debug: false } } }
    const { event, flashed } = createEvent('invalid-email', 'application/json', path, { routeId })
    const hooks = createSvelteKitHoloHooks({ handle: ({ event, resolve }) => resolve(event) })
    const response = await hooks.handle({ event, resolve: async (event) => {
      await validate(await event.request.formData(), loginSchema)
      return new Response('success')
    } })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ valid: false, status: 422, values: { email: 'invalid-email' } })
    expect(flashed.size).toBe(0)
  })

  it.each([
    ['an API route under the base path', 'GET', 'application/json', '/dashboard/api/posts?after=abc', '/api/posts', {}],
    ['a JSON endpoint outside /api/', 'GET', 'application/json', '/posts.json?after=abc', '/posts.json', {}],
    ['a non-form method endpoint', 'DELETE', 'text/html', '/dashboard/posts/1?after=abc', '/posts/[id]', { id: '1' }],
    ['an API route behind an omitted optional parameter', 'GET', 'text/html', '/dashboard/api/posts?after=abc', '/[[lang]]/api/posts', {}],
    ['a catch-all route serving api/ under the base path', 'GET', 'text/html', '/dashboard/api/posts?after=abc', '/[...path]', { path: 'api/posts' }],
  ])('answers an invalid cursor on %s with 422 JSON and no flash cookie', async (_label, method, accept, path, routeId, params) => {
    (adapterSvelteKitInternals.getState() as { project?: unknown }).project = { config: { app: { key: 'hooks-test-app-key', debug: false } } }
    const { event, flashed } = createEvent('ignored', accept, path, { method, routeId, params })
    const hooks = createSvelteKitHoloHooks({ handle: ({ event, resolve }) => resolve(event) })
    const response = await hooks.handle({ event, resolve: async (event) => {
      await hooks.handleError({ event, kind: 'unknown', error: new InvalidCursorException('after', 'Reload the feed.') })
      return new Response('native failure', { status: 500 })
    } })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ status: 422, errors: { after: ['Reload the feed.'] } })
    expect(flashed.size).toBe(0)
  })

  it('cleans failures after handler errors and ignores late validation reports', async () => {
    const { event, flashed } = createEvent('invalid-email')
    const ordinaryError = new Error('ordinary failure')
    const hooks = createSvelteKitHoloHooks({
      handle: ({ event, resolve }) => resolve(event),
      handleError: ({ error }) => ({ message: error === ordinaryError ? 'application error' : 'unexpected' }),
    })
    await expect(hooks.handle({ event, resolve: async (event) => {
      await hooks.handleError({ event, kind: 'unknown', error: ValidationException.withMessages({ email: ['Invalid.'] }) })
      throw ordinaryError
    } })).rejects.toBe(ordinaryError)
    flashed.clear()
    await hooks.handleError({ event: { ...event }, kind: 'unknown', error: ValidationException.withMessages({ email: ['Late failure.'] }) })
    expect(flashed.size).toBe(0)
    expect(await hooks.handleError({ event, kind: 'unknown', error: ordinaryError })).toEqual({ message: 'application error' })
    const response = await hooks.handle({ event, resolve: async () => new Response('success') })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('success')
    await hooks.handleError({ event, kind: 'unknown', error: ValidationException.withMessages({ email: ['After success.'] }) })
    expect(flashed.size).toBe(0)
  })

})

afterEach(() => {
  (adapterSvelteKitInternals.getState() as { project?: unknown }).project = undefined
})
