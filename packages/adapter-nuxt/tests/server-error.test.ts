import { createApp, defineEventHandler } from 'h3'
import { expect, it } from 'vitest'
import { ValidationException } from '@holo-js/validation'
import handleValidationError from '../src/runtime/server/error'
import { serve } from './support/http'

it('lets native HTTP error handling handle ordinary failures without validation flash cookies', async () => {
  const app = createApp({ onError: handleValidationError })
  app.use(defineEventHandler(() => {
    throw new Error('ordinary failure', { cause: null })
  }))
  const response = await fetch(await serve(app))
  expect(response.status).toBe(500)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(await response.json()).toMatchObject({ statusCode: 500 })
})

it('serializes wrapped validation failures through a real HTTP response', async () => {
  const app = createApp({ onError: handleValidationError })
  app.use(defineEventHandler(() => {
    throw new Error('wrapped failure', { cause: ValidationException.withMessages({ email: ['Invalid email.'] }) })
  }))
  const response = await fetch(await serve(app), { headers: { accept: 'application/json' } })
  expect(response.status).toBe(422)
  expect(response.headers.get('content-type')).toContain('application/json')
  expect(await response.json()).toMatchObject({ status: 422, errors: { email: ['Invalid email.'] } })
})

it('redirects a real browser form request back to its page with flashed validation errors', async () => {
  const app = createApp({ onError: handleValidationError })
  app.use(defineEventHandler(() => {
    throw ValidationException.withMessages({ image: ['The selected file must be 2 MB or smaller.'] })
  }))
  const baseUrl = await serve(app)
  const response = await fetch(baseUrl + '/profile', {
    method: 'POST',
    redirect: 'manual',
    headers: { accept: 'text/html', referer: baseUrl + '/profile/edit' },
    body: new URLSearchParams({ name: 'Ava' }),
  })
  expect(response.status).toBe(303)
  expect(response.headers.get('location')).toBe('/profile/edit')
  expect(response.headers.get('set-cookie')).toContain('holo_form_failure=')
  expect(await response.text()).toBe('')
})
