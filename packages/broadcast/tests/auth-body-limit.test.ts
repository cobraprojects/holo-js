import { describe, expect, it } from 'vitest'
import { renderBroadcastAuthResponse } from '../src'

describe('broadcast auth request body limit', () => {
  it('answers 413 when the auth body exceeds the request body limit', async () => {
    const response = await renderBroadcastAuthResponse(new Request('https://app.test/broadcasting/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `channel_name=${'x'.repeat(1024 * 1024)}`,
    }))

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'invalid-request' })
  })
})
