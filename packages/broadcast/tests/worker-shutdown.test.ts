import { expect, it } from 'vitest'
import { createBroadcastWorkerRuntime, normalizeBroadcastConfig } from '../src'

const app = { connection: 'main', appId: 'main', key: 'main-key', secret: 'main-secret' }

it('closes a socket accepted while the runtime is shutting down and never registers it', async () => {
  const runtime = createBroadcastWorkerRuntime({
    config: normalizeBroadcastConfig({
      default: 'main',
      connections: { main: { driver: 'holo', appId: 'main', key: 'main-key', secret: 'main-secret' } },
    }),
  })
  const sent: string[] = []
  const closes: Array<{ code?: number, reason?: string }> = []

  const closing = runtime.close()
  runtime.connectWebSocket({
    socketId: 'late-socket',
    app,
    headers: new Headers(),
    send: payload => sent.push(payload),
    close: (code, reason) => closes.push({ code, reason }),
    bufferedAmount: () => 0,
  })
  await runtime.receiveWebSocketMessage('late-socket', JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'public.news' } }))
  await closing

  expect(closes).toEqual([{ code: 1001, reason: 'Worker shutdown' }])
  expect(sent).toEqual([])
  expect(runtime.getStats()).toMatchObject({ connectionCount: 0, subscribedChannelCount: 0 })
})
