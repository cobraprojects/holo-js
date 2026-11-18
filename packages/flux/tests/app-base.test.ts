import { afterEach, expect, it, vi } from 'vitest'
import { getFluxClient, resetFluxClient } from '../src'

class IdleSocket {
  static opened: string[] = []
  readyState = 0
  constructor(readonly url: string) {
    IdleSocket.opened.push(url)
  }
  send() {}
  close() {}
  addEventListener() {}
}

afterEach(() => {
  resetFluxClient()
  vi.unstubAllGlobals()
  IdleSocket.opened = []
})

async function discoveredEndpoint(base?: string): Promise<string | undefined> {
  const requested: string[] = []
  vi.stubGlobal('window', {})
  vi.stubGlobal('location', { protocol: 'http:', hostname: '127.0.0.1' })
  vi.stubGlobal('WebSocket', IdleSocket)
  vi.stubGlobal('fetch', async (endpoint: string) => {
    requested.push(endpoint)
    return { ok: true, status: 200, json: async () => ({ key: 'key', host: '127.0.0.1', port: 8080, path: 'app', scheme: 'http' }) }
  })
  const client = getFluxClient()
  if (base !== undefined) vi.stubGlobal('__HOLO_APP_BASE__', base)
  void client.connect().catch(() => {})
  await vi.waitFor(() => expect(IdleSocket.opened).toHaveLength(1))
  await client.disconnect()
  return requested[0]
}

it('discovers the broadcast config at the root when no adapter defines an app base', async () => {
  expect(await discoveredEndpoint()).toBe('/broadcasting/config')
})

it('discovers the broadcast config under an app base set after the default client was created', async () => {
  expect(await discoveredEndpoint('/dashboard')).toBe('/dashboard/broadcasting/config')
})
