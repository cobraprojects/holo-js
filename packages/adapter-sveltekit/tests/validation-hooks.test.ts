import type { RequestEvent } from '@sveltejs/kit'
import { describe, expect, it } from 'vitest'
import { ValidationException, field, schema, validate } from '@holo-js/validation'
import { createSvelteKitHoloHooks } from '../src'

function createEvent(value: string, accept = 'application/json', path = '/login') {
  const flashed = new Map<string, string>()
  const event: Partial<RequestEvent> = {
    url: new URL(`https://app.test${path}`),
    request: new Request(`https://app.test${path}`, {
      method: 'POST',
      headers: { accept },
      body: new URLSearchParams({ email: value, password: 'private-password' }),
    }),
    cookies: {
      get: (name: string) => flashed.get(name),
      getAll: () => [...flashed].map(([name, value]) => ({ name, value })),
      delete: (name: string) => { flashed.delete(name) },
      serialize: (name: string, value: string) => `${name}=${value}`,
      set: (name: string, value: string) => { flashed.set(name, value) },
    },
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
        await hooks.handleError({ event: { ...event }, error, status: 500, message: 'failure' })
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
    }
  })
  it('preserves browser redirects and filters sensitive flashed values', async () => {
    const { event, flashed } = createEvent('invalid-email', 'text/html', '/login?/submit')
    const hooks = createSvelteKitHoloHooks({ handle: ({ event, resolve }) => resolve(event) })
    const response = await hooks.handle({ event, resolve: async (event) => {
      try {
        await validate(await event.request.formData(), loginSchema)
      } catch (error) {
        await hooks.handleError({ event: { ...event }, error, status: 500, message: 'failure' })
      }
      return new Response('native failure', { status: 500 })
    } })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/login')
    expect(response.headers.get('cache-control')).toBe('no-store')
    const cookie = flashed.get('HOLO-SVELTEKIT-VALIDATION')
    expect(cookie).toBeDefined()
    expect(JSON.parse(decodeURIComponent(cookie ?? ''))).toMatchObject({ values: { email: 'invalid-email' } })
    expect(decodeURIComponent(cookie ?? '')).not.toContain('private-password')
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
    expect(await response.json()).toMatchObject({ valid: false, status: 422, values: { email: 'invalid-email' } })
  })

  it('cleans failures after handler errors and ignores late validation reports', async () => {
    const { event, flashed } = createEvent('invalid-email')
    const ordinaryError = new Error('ordinary failure')
    const hooks = createSvelteKitHoloHooks({
      handle: ({ event, resolve }) => resolve(event),
      handleError: ({ error }) => ({ message: error === ordinaryError ? 'application error' : 'unexpected' }),
    })
    await expect(hooks.handle({ event, resolve: async (event) => {
      await hooks.handleError({ event, error: ValidationException.withMessages({ email: ['Invalid.'] }), status: 500, message: 'failure' })
      throw ordinaryError
    } })).rejects.toBe(ordinaryError)
    flashed.clear()
    await hooks.handleError({ event: { ...event }, error: ValidationException.withMessages({ email: ['Late failure.'] }), status: 500, message: 'failure' })
    expect(flashed.size).toBe(0)
    expect(await hooks.handleError({ event, error: ordinaryError, status: 500, message: 'failure' })).toEqual({ message: 'application error' })
    const response = await hooks.handle({ event, resolve: () => new Response('success') })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('success')
    await hooks.handleError({ event, error: ValidationException.withMessages({ email: ['After success.'] }), status: 500, message: 'failure' })
    expect(flashed.size).toBe(0)
  })

})
