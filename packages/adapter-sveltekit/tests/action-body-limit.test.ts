import { describe, expect, it } from 'vitest'
import { field, schema } from '@holo-js/validation'
import { validate } from '@holo-js/forms'
import { runWithSvelteKitRequestEvent } from '../src'

describe('oversized action submissions', () => {
  it('answers an oversized action submission with HTTP 413 through SvelteKit error handling', async () => {
    const event = {
      url: new URL('https://app.test/login'),
      request: new Request('https://app.test/login', { method: 'POST' }),
      cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
      getClientAddress: () => '127.0.0.1',
    }
    const oversized = new Request('https://app.test/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'ava@example.com', padding: 'x'.repeat(2 * 1024 * 1024) }),
    })
    const loginSchema = schema({ email: field.string().required() })

    const thrown = await runWithSvelteKitRequestEvent(event as never, async () => {
      await validate(oversized, loginSchema)
    }).catch((error: unknown) => error)

    expect(thrown).toMatchObject({ status: 413, body: { message: expect.any(String) } })
  })
})
