import { createApp, defineEventHandler } from 'h3'
import { expect, it } from 'vitest'
import { createNuxtAuthorizationError } from '../src/runtime/authorization-error'
import { serve } from './support/http'

it('returns native HTTP authorization errors with the intended status and message', async () => {
  const app = createApp()
  app.use(defineEventHandler(event => {
    throw createNuxtAuthorizationError(event.path === '/hidden' ? { status: 404 } : { status: 403, message: 'Denied' })
  }))
  const baseUrl = await serve(app)
  const hidden = await fetch(baseUrl + '/hidden')
  expect(hidden.status).toBe(404)
  expect(await hidden.json()).toMatchObject({ statusCode: 404, statusMessage: 'You are not authorized to perform this action.' })
  const denied = await fetch(baseUrl + '/denied')
  expect(denied.status).toBe(403)
  expect(await denied.json()).toMatchObject({ statusCode: 403, statusMessage: 'Denied' })
})
