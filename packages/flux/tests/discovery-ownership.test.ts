import { afterEach, expect, it, vi } from 'vitest'
import { fluxInternals } from '../src'

class SocketAdapter {
  static sockets: SocketAdapter[] = []
  readyState = 0
  readonly frames: string[] = []
  readonly listeners = new Map<string, Array<(event: { readonly data: string }) => void>>()

  constructor(readonly url: string) {
    SocketAdapter.sockets.push(this)
  }

  send(data: string): void {
    this.frames.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit('close')
  }

  addEventListener(event: string, listener: (event: { readonly data: string }) => void): void {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
  }

  emit(event: string, data = ''): void {
    if (event === 'open') this.readyState = 1
    for (const listener of this.listeners.get(event) ?? []) listener({ data })
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  SocketAdapter.sockets = []
})

it('keeps private authorization on the active configuration when cancelled discovery completes', async () => {
  const requests: string[] = []
  const discoveries: Array<(response: Response) => void> = []
  vi.stubGlobal('WebSocket', SocketAdapter)
  vi.stubGlobal('window', {})
  vi.stubGlobal('location', { hostname: 'localhost', protocol: 'http:' })
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url)
    if (url === '/config') {
      return await new Promise<Response>((resolve) => { discoveries.push(resolve) })
    }
    return Response.json({ auth: 'authorized' })
  })
  const connector = fluxInternals.createHoloWebSocketConnector({ configEndpoint: '/config' })
  const config = (authEndpoint: string): Response => Response.json({
    key: 'key', host: 'localhost', port: 8080, path: '/app', scheme: 'http', authEndpoint,
  })

  try {
    const cancelled = connector.connect()
    const rejected = expect(cancelled).rejects.toThrow('WebSocket connection failed')
    await vi.waitFor(() => expect(discoveries).toHaveLength(1))
    await connector.disconnect()
    await rejected
    const current = connector.connect()
    await vi.waitFor(() => expect(discoveries).toHaveLength(2))
    discoveries[1]!(config('/new-auth'))
    await vi.waitFor(() => expect(SocketAdapter.sockets).toHaveLength(1))
    const socket = SocketAdapter.sockets[0]!
    socket.emit('open')
    await current
    socket.emit('message', JSON.stringify({
      event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '1.1' }),
    }))
    discoveries[0]!(config('/stale-auth'))
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    connector.subscribe('room', 'private')
    await vi.waitFor(() => expect(socket.frames).toHaveLength(1))
    expect(requests).toEqual(['/config', '/config', '/new-auth'])
    expect(JSON.parse(socket.frames[0]!)).toEqual({
      event: 'pusher:subscribe', data: { channel: 'private-room', auth: 'authorized' },
    })
    expect(SocketAdapter.sockets).toHaveLength(1)
  } finally {
    await connector.disconnect()
  }
})
