import { createApp, createError, defineEventHandler } from 'h3'
import { expect, it, onTestFinished } from 'vitest'
import { requestUrlInternals } from '@holo-js/kernel'
import { field, isValidationException, schema, serializeValidationException, validate, ValidationException, validationInternals } from '@holo-js/validation'
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

it('preserves serialized H3 validation fields and retry metadata over HTTP', async () => {
  const exception = ValidationException.withMessages({ file: ['Upload a square avatar.'] }, { bag: 'avatar' })
  validationInternals.setValidationExceptionValues(exception, { title: 'Profile' })
  validationInternals.setValidationExceptionStatus(exception, 429)
  validationInternals.setValidationExceptionMetadata(exception, { retryAfterSeconds: 30, retryAt: '2026-10-18T12:00:00Z' })
  const payload = exception.toJSON()
  const error = createError({ statusCode: 429, data: payload })
  expect(isValidationException(error)).toBe(false)
  expect(serializeValidationException(error)).toEqual(payload)
  const app = createApp({ onError: handleValidationError })
  app.use(defineEventHandler(() => { throw error }))
  const response = await fetch(await serve(app), { headers: { accept: 'application/json' } })
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBe('30')
  expect(await response.json()).toEqual(payload)
})

const loginSchema = schema({ email: field.string().required().email(), password: field.password().required() })

function loginApp() {
  const app = createApp({ onError: handleValidationError })
  app.use(defineEventHandler(async () => {
    await validate({ email: 'invalid', password: 'nuxt-password' }, loginSchema)
  }))
  return app
}

function submitLoginForm(baseUrl: string) {
  return fetch(baseUrl + '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { accept: 'text/html', referer: baseUrl + '/login' },
    body: new URLSearchParams({ email: 'invalid', password: 'nuxt-password' }),
  })
}

function readFormFailureCookie(response: Response) {
  const cookie = response.headers.get('set-cookie') ?? ''
  const value = cookie.split(';')[0]?.split('=').slice(1).join('=') ?? ''
  return { cookie, payload: JSON.parse(decodeURIComponent(value)) as Record<string, unknown> }
}

it('answers JSON validation failures without the submitted password', async () => {
  const response = await fetch(await serve(loginApp()), { method: 'POST', headers: { accept: 'application/json' } })
  expect(response.status).toBe(422)
  const body = await response.text()
  expect(JSON.parse(body)).toMatchObject({ values: { email: 'invalid' } })
  expect(body).not.toContain('nuxt-password')
})

it('flashes form failures in a cookie that carries no submitted values', async () => {
  const response = await submitLoginForm(await serve(loginApp()))
  expect(response.status).toBe(303)
  const { cookie, payload } = readFormFailureCookie(response)
  expect(payload).toMatchObject({ bag: 'default', errors: { email: ['This field must be a valid email address.'] } })
  expect(payload).not.toHaveProperty('values')
  expect(cookie).not.toContain('invalid%22')
  expect(cookie).not.toMatch(/;\s*Secure/i)
})

it('marks the form failure cookie Secure when the request arrived over HTTPS', async () => {
  requestUrlInternals.configureForwardedRequestResolver(() => ({ protocol: 'https' }))
  onTestFinished(() => requestUrlInternals.configureForwardedRequestResolver(undefined))
  const response = await submitLoginForm(await serve(loginApp()))
  expect(response.status).toBe(303)
  expect(readFormFailureCookie(response).cookie).toMatch(/;\s*Secure/i)
})

it('answers an oversized form body with 413 through a real HTTP response, without a validation redirect', async () => {
  const app = createApp({ onError: handleValidationError })
  app.use(defineEventHandler(() => validate(new Request('https://app.test/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `email=ava%40example.com&padding=${'x'.repeat(2 * 1024 * 1024)}`,
  }), schema({ email: field.string().required() }))))
  const response = await fetch(await serve(app), {
    method: 'POST',
    headers: { accept: 'text/html' },
    redirect: 'manual',
  })
  expect(response.status).toBe(413)
  expect(response.headers.get('location')).toBeNull()
  expect(await response.json()).toMatchObject({ status: 413 })
})
