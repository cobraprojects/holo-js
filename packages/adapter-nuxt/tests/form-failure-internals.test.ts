import { requestUrlInternals } from '@holo-js/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { configureSecurityRuntime, resetSecurityRuntime } from '../../security/src'
import { applyFormFailureRedirect, formFailureInternals, type NitroResponse } from '../src/runtime/server/form-failure'

afterEach(() => {
  resetSecurityRuntime()
  requestUrlInternals.provideConnectionAddress(undefined)
})

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

  it('marks the flashed failure cookie Secure from X-Forwarded-Proto only when the peer is a trusted proxy', () => {
    const flash = () => {
      const response: NitroResponse = {}
      applyFormFailureRedirect(
        { path: '/login', node: { req: { method: 'POST', headers: { host: 'app.test', 'x-forwarded-proto': 'https' } } } },
        response,
        { ok: false, status: 422, valid: false, errors: { email: ['Invalid.'] }, values: {} },
      )
      return String((response.headers as Record<string, unknown>)['set-cookie'])
    }
    requestUrlInternals.provideConnectionAddress(() => '198.51.100.4')
    configureSecurityRuntime({ config: { trustedProxies: ['127.0.0.1'] } })
    expect(flash()).not.toMatch(/; Secure$/)
    configureSecurityRuntime({ config: { trustedProxies: ['198.51.100.4'] } })
    expect(flash()).toMatch(/; Secure$/)
  })
})
