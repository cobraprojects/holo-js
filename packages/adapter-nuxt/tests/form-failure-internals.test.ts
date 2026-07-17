import { describe, expect, it } from 'vitest'
import { formFailureInternals } from '../src/runtime/server/form-failure'

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
})
