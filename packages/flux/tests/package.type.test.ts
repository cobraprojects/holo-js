import { describe, it, expectTypeOf } from 'vitest'
import type { BroadcastJsonObject } from '@holo-js/broadcast'
import { createFluxClient, fluxInternals } from '../src'

describe('@holo-js/flux typing', () => {
  it('infers channel/event/whisper names from generated manifest metadata', async () => {
    const manifest = {
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      events: [{
        name: 'orders.updated',
        channels: [{
          type: 'private',
          pattern: 'orders.{orderId}',
        }],
      }, {
        name: 'orders.shipped',
        channels: [{
          type: 'private',
          pattern: 'orders.{orderId}',
        }],
      }],
      channels: [{
        name: 'orders.{orderId}',
        pattern: 'orders.{orderId}',
        type: 'private',
        params: ['orderId'],
        whispers: ['typing.start'],
      }],
    } as const

    const presenceManifest = {
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      events: [{
        name: 'chat.message',
        channels: [{
          type: 'presence',
          pattern: 'chat.{roomId}',
        }],
      }],
      channels: [{
        name: 'chat.{roomId}',
        pattern: 'chat.{roomId}',
        type: 'presence',
        params: ['roomId'],
        whispers: ['typing.start'],
        member: {
          id: 'user-1',
          name: 'Ada',
        },
      }],
    } as const

    const client = createFluxClient({
      manifest,
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const subscription = client.private('orders.{orderId}')
    const presenceSubscription = createFluxClient({
      manifest: presenceManifest,
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    }).presence('chat.{roomId}')

    subscription.listen('orders.updated', (payload) => {
      expectTypeOf(payload).toMatchTypeOf<BroadcastJsonObject>()
    })
    subscription.listen(['orders.updated', 'orders.shipped'], (payload) => {
      expectTypeOf(payload).toMatchTypeOf<BroadcastJsonObject>()
    })
    subscription.listenForWhisper('typing.start', (payload) => {
      expectTypeOf(payload).toMatchTypeOf<BroadcastJsonObject>()
    })
    await subscription.whisper('typing.start', {
      editing: true,
    })
    expectTypeOf(presenceSubscription.members).toEqualTypeOf<readonly {
      readonly id: 'user-1'
      readonly name: 'Ada'
    }[]>()

    // @ts-expect-error not in manifest event names
    subscription.listen('orders.deleted', () => {})
    // @ts-expect-error not in manifest whisper names
    subscription.listenForWhisper('typing.stop', () => {})
    // @ts-expect-error not in manifest whisper names
    await subscription.whisper('typing.stop', {})
  })

  it('keeps event inference when a broadcast targets multiple channels', () => {
    const client = createFluxClient({
      manifest: {
        version: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        events: [{
          name: 'orders.updated',
          channels: [
            {
              type: 'private',
              pattern: 'orders.{orderId}',
            },
            {
              type: 'presence',
              pattern: 'chat.{roomId}',
            },
          ],
        }],
        channels: [{
          name: 'orders.{orderId}',
          pattern: 'orders.{orderId}',
          type: 'private',
          params: ['orderId'],
          whispers: [],
        }, {
          name: 'chat.{roomId}',
          pattern: 'chat.{roomId}',
          type: 'presence',
          params: ['roomId'],
          whispers: [],
          member: {
            id: 'user-1',
          },
        }],
      },
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })

    client.private('orders.{orderId}').listen('orders.updated', (payload) => {
      expectTypeOf(payload).toMatchTypeOf<BroadcastJsonObject>()
    })
    client.presence('chat.{roomId}').listen('orders.updated', (payload) => {
      expectTypeOf(payload).toMatchTypeOf<BroadcastJsonObject>()
    })
  })
})
