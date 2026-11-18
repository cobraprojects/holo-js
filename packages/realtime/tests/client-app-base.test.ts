import { afterEach, expect, it, vi } from 'vitest'
import { createBroadcastRealtimeTransport, resetRealtimeClientRuntime } from '../src/client'

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
  resetRealtimeClientRuntime()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  IdleSocket.opened = []
})

async function requestedEndpoints(): Promise<string[]> {
  const requested: string[] = []
  vi.stubGlobal('WebSocket', IdleSocket)
  vi.stubGlobal('fetch', async (endpoint: string) => {
    requested.push(endpoint)
    return { ok: true, status: 200, json: async () => ({ key: 'key', host: '127.0.0.1', port: 8080, path: 'app', scheme: 'http' }) }
  })
  const transport = createBroadcastRealtimeTransport()
  await transport.query('posts.list', {})
  await transport.mutate('posts.save', {})
  const unsubscribe = transport.subscribe('posts.list', {}, () => {}, () => {})
  await vi.waitFor(() => expect(IdleSocket.opened).toHaveLength(1))
  unsubscribe()
  return requested
}

it('uses root endpoints when no adapter defines an app base', async () => {
  expect(await requestedEndpoints()).toEqual(['/holo/realtime/query', '/holo/realtime/mutation', '/broadcasting/config'])
})

it('prefixes every endpoint with the app base an adapter defines', async () => {
  vi.stubGlobal('__HOLO_APP_BASE__', '/dashboard')
  expect(await requestedEndpoints()).toEqual(['/dashboard/holo/realtime/query', '/dashboard/holo/realtime/mutation', '/dashboard/broadcasting/config'])
})
