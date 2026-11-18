import { afterEach, expect, it, vi } from 'vitest'
import { fluxInternals } from '../src'

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
  vi.unstubAllGlobals()
  IdleSocket.opened = []
})

async function discoveredEndpoint(): Promise<string | undefined> {
  const requested: string[] = []
  vi.stubGlobal('window', {})
  vi.stubGlobal('location', { protocol: 'http:', hostname: '127.0.0.1' })
  vi.stubGlobal('WebSocket', IdleSocket)
  vi.stubGlobal('fetch', async (endpoint: string) => {
    requested.push(endpoint)
    return { ok: true, status: 200, json: async () => ({ key: 'key', host: '127.0.0.1', port: 8080, path: 'app', scheme: 'http' }) }
  })
  const connector = fluxInternals.createHoloWebSocketConnector()
  void connector.connect().catch(() => {})
  await vi.waitFor(() => expect(IdleSocket.opened).toHaveLength(1))
  await connector.disconnect()
  return requested[0]
}

it('discovers the broadcast config at the root when no adapter defines an app base', async () => {
  expect(await discoveredEndpoint()).toBe('/broadcasting/config')
})

it('discovers the broadcast config under the app base an adapter defines', async () => {
  vi.stubGlobal('__HOLO_APP_BASE__', '/dashboard')
  expect(await discoveredEndpoint()).toBe('/dashboard/broadcasting/config')
})
