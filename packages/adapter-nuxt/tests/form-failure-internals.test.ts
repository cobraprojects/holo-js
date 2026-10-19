import { describe, expect, it } from 'vitest'
import { applyFormFailureRedirect, formFailureInternals, type NitroResponse } from '../src/runtime/server/form-failure'

describe('Nuxt form failure internals', () => {
  it('writes the first fallback response cookie as a string', () => {
    const response: { headers?: Record<string, number | string | readonly string[]> } = {}
    formFailureInternals.appendSetCookie({}, response, 'holo_form_failure=value')
    expect(response.headers?.['set-cookie']).toBe('holo_form_failure=value')
  })

  it('appends to an existing fallback response cookie', () => {
    const response = { headers: { 'set-cookie': 'session=value' } }
    formFailureInternals.appendSetCookie({}, response, 'holo_form_failure=value')
    expect(response.headers['set-cookie']).toEqual(['session=value', 'holo_form_failure=value'])
  })

  it('marks the flashed failure cookie Secure for requests served directly over TLS', () => {
    const response: NitroResponse = {}
    applyFormFailureRedirect(
      { path: '/login', node: { req: { method: 'POST', headers: { host: 'app.test' }, socket: { encrypted: true } } } },
      response,
      { ok: false, status: 422, valid: false, errors: { email: ['Invalid.'] }, values: { email: 'ava' } },
    )
    const cookie = String((response.headers as Record<string, unknown>)['set-cookie'])
    expect(cookie).toMatch(/; Secure$/)
    expect(decodeURIComponent(cookie)).not.toContain('ava')
  })
})
