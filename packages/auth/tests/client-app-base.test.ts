import { afterEach, expect, it, vi } from 'vitest'
import { refreshUser, resetAuthClient } from '../src/client'

afterEach(() => {
  resetAuthClient()
  vi.unstubAllGlobals()
})

async function requestedEndpoint(): Promise<string> {
  const requested: string[] = []
  vi.stubGlobal('fetch', async (endpoint: string) => {
    requested.push(endpoint)
    return Response.json({ authenticated: false, guard: 'web', provider: null, user: null })
  })
  await refreshUser()
  return requested[0] ?? ''
}

it('requests the current user at the root when no adapter defines an app base', async () => {
  expect(await requestedEndpoint()).toBe('/api/auth/user')
})

it('requests the current user under the app base an adapter defines', async () => {
  vi.stubGlobal('__HOLO_APP_BASE__', '/dashboard')
  expect(await requestedEndpoint()).toBe('/dashboard/api/auth/user')
})
