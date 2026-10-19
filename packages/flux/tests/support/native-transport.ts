import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:net'
import { expect, onTestFinished } from 'vitest'
import { defineChannel, normalizeBroadcastConfig, startBroadcastWorker, type BroadcastJsonObject } from '@holo-js/broadcast'
import { createFluxClient, fluxInternals, resetFluxClient } from '../../src'
import { defineSchema, field } from '../../../validation/src'

export async function startNativeTransport(options: { allowedOrigins?: readonly string[], authorizeOrders?: () => boolean } = {}) {
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('No broadcast port available')
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  const worker = await startBroadcastWorker({
    channelAuth: {
      resolveUser: ({ socketId }) => ({ id: socketId }),
      definitions: [defineChannel('App.Models.User.{userId}', {
        type: 'private',
        authorize: () => true,
        whispers: {
          'typing.start': defineSchema({ editing: field.boolean().required() }),
        },
      }), defineChannel('orders.{orderId}', {
        type: 'private',
        authorize: () => options.authorizeOrders?.() ?? true,
      }), defineChannel('chat.{roomId}', {
        type: 'presence',
        authorize: user => user && typeof user === 'object' && 'id' in user && typeof user.id === 'string' ? { id: user.id } : false,
        whispers: {},
      })],
    },
    config: normalizeBroadcastConfig({
      default: 'main',
      connections: { main: { driver: 'holo', appId: 'app', key: 'key', secret: 'secret' } },
      worker: { host: '127.0.0.1', port: address.port, statsEnabled: true, ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}) },
    }),
  })
  const baseUrl = `http://127.0.0.1:${worker.port}`
  const clients: ReturnType<typeof createFluxClient>[] = []
  const createClient = () => {
    const client = createFluxClient({
      connector: fluxInternals.createHoloWebSocketConnector({ key: 'key', host: worker.host, port: worker.port, scheme: 'http' }),
    })
    clients.push(client)
    return client
  }
  const client = createClient()
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await worker.stop()
  }
  onTestFinished(async () => {
    resetFluxClient()
    await Promise.all(clients.map(client => client.disconnect()))
    await stop()
  })
  return {
    connection: { key: 'key', host: worker.host, port: worker.port, scheme: 'http' as const },
    client,
    createClient,
    stop,
    async subscriptions(): Promise<number> {
      const response = await fetch(`${baseUrl}/stats`)
      expect(response.status).toBe(200)
      const stats = await response.json() as { subscribedChannelCount: number }
      return stats.subscribedChannelCount
    },
    async publish(title: string, options: { event?: string, channels?: readonly string[], payload?: BroadcastJsonObject } = {}): Promise<void> {
      const body = JSON.stringify({ name: options.event ?? 'feed.updated', channels: options.channels ?? ['feed', 'barrier'], data: JSON.stringify(options.payload ?? { title }) })
      const url = new URL('/apps/app/events', baseUrl)
      url.searchParams.set('auth_key', 'key')
      url.searchParams.set('auth_timestamp', String(Math.floor(Date.now() / 1000)))
      url.searchParams.set('auth_version', '1.0')
      url.searchParams.set('body_md5', createHash('md5').update(body).digest('hex'))
      const query = [...url.searchParams].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join('&')
      url.searchParams.set('auth_signature', createHmac('sha256', 'secret').update(`POST\n${url.pathname}\n${query}`).digest('hex'))
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      expect(response.status, await response.text()).toBe(200)
    },
  }
}

