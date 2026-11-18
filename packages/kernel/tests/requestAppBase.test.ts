import { describe, expect, it } from 'vitest'
import { requestAppBaseInternals } from '../src'

describe('request app base', () => {
  it('reads the path inside the app base a framework integration records', () => {
    const request = new Request('https://app.test/dashboard/broadcasting/auth')
    requestAppBaseInternals.set(request, '/dashboard')
    expect(requestAppBaseInternals.pathname(request)).toBe('/broadcasting/auth')
    expect(requestAppBaseInternals.withBase(request, '/login')).toBe('/dashboard/login')
  })

  it.each([
    ['https://app.test/dashboard', '/'],
    ['https://app.test/dashboard/', '/'],
    ['https://app.test/dashboardx/admin', '/dashboardx/admin'],
  ])('maps %s inside the /dashboard base to %s', (url, expected) => {
    const request = new Request(url)
    requestAppBaseInternals.set(request, '/dashboard')
    expect(requestAppBaseInternals.pathname(request)).toBe(expected)
  })

  it('compares a configured base in the encoded form request paths use', () => {
    const request = new Request('https://app.test/caf%C3%A9/broadcasting/auth')
    requestAppBaseInternals.set(request, '/café/')
    expect(requestAppBaseInternals.pathname(request)).toBe('/broadcasting/auth')
  })

  it('carries a base recorded on a framework event over to the request built from it', () => {
    const event = {}
    requestAppBaseInternals.set(event, '/dashboard/')
    expect(requestAppBaseInternals.base(event)).toBe('/dashboard')
    expect(requestAppBaseInternals.base({})).toBe('')
  })

  it('uses the request path unchanged when no base was recorded', () => {
    const request = new Request('https://app.test/broadcasting/auth')
    expect(requestAppBaseInternals.pathname(request)).toBe('/broadcasting/auth')
    expect(requestAppBaseInternals.withBase(request, '/login')).toBe('/login')
  })
})
