import { describe, it, expectTypeOf } from 'vitest'
import type { BroadcastJsonObject } from '@holo-js/broadcast'
import { createFluxClient, fluxInternals } from '../src'

describe('@holo-js/flux typing', () => {
  it('preserves member inference with readonly arrays through adapter internals', () => {
    const members: readonly { readonly id: string, readonly name: string }[] = [{ id: 'user-1', name: 'Ada' }]
    const appended = fluxInternals.appendPresenceMember(members, { id: 'user-2', name: 'Grace' })
    const removed = fluxInternals.removePresenceMember(appended, { id: 'user-1', name: 'Ada' })

    expectTypeOf(appended).toEqualTypeOf<readonly { readonly id: string, readonly name: string }[]>()
    expectTypeOf(removed).toEqualTypeOf<typeof appended>()
  })

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
      expectTypeOf(payload).toEqualTypeOf<BroadcastJsonObject>()
    })
    subscription.listen(['orders.updated', 'orders.shipped'], (payload) => {
      expectTypeOf(payload).toEqualTypeOf<BroadcastJsonObject>()
    })
    subscription.listenForWhisper('typing.start', (payload) => {
      expectTypeOf(payload).toEqualTypeOf<BroadcastJsonObject>()
    })
    await subscription.whisper('typing.start', {
      editing: true,
    })
    expectTypeOf(presenceSubscription.members).toEqualTypeOf<readonly {
      readonly id: 'user-1'
      readonly name: 'Ada'
    }[]>()
    presenceSubscription.here((members) => {
      expectTypeOf(members).toEqualTypeOf<readonly {
        readonly id: 'user-1'
        readonly name: 'Ada'
      }[]>()
    }).joining((member) => {
      expectTypeOf(member).toEqualTypeOf<{
        readonly id: 'user-1'
        readonly name: 'Ada'
      }>()
    }).leaving((member) => {
      expectTypeOf(member).toEqualTypeOf<{
        readonly id: 'user-1'
        readonly name: 'Ada'
      }>()
    })

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
      expectTypeOf(payload).toEqualTypeOf<BroadcastJsonObject>()
    })
    client.presence('chat.{roomId}').listen('orders.updated', (payload) => {
      expectTypeOf(payload).toEqualTypeOf<BroadcastJsonObject>()
    })
  })

  it('rejects manifest events that do not target the subscribed channel', () => {
    const client = createFluxClient({
      manifest: {
        version: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        events: [{
          name: 'orders.updated',
          channels: [{
            type: 'private',
            pattern: 'orders.{orderId}',
          }],
        }, {
          name: 'chat.message',
          channels: [{
            type: 'presence',
            pattern: 'chat.{roomId}',
          }],
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
      expectTypeOf(payload).toEqualTypeOf<BroadcastJsonObject>()
    })
    const dynamicSubscription = client.private('orders.1')
    expectTypeOf(dynamicSubscription.name).toEqualTypeOf<'orders.1'>()
    dynamicSubscription.listen(['orders.updated', 'chat.message'], (payload) => {
      expectTypeOf(payload).toEqualTypeOf<BroadcastJsonObject>()
      // @ts-expect-error core callbacks retain JSON values rather than registry payload fields
      const orderId: string = payload.orderId
      void orderId
    })
    expectTypeOf(client.presence('orders.{orderId}').members).toEqualTypeOf<readonly unknown[]>()
    expectTypeOf(client.presence('chat.1').members).toEqualTypeOf<readonly unknown[]>()
    // @ts-expect-error dynamic channels still restrict names to manifest events
    dynamicSubscription.listen('orders.deleted', () => {})
    // @ts-expect-error dynamic channels do not invent manifest whisper names
    dynamicSubscription.listenForWhisper('typing.start', () => {})
    const defaultClient = createFluxClient({ connector: fluxInternals.createPusherConnector({ transport: 'mock' }) })
    defaultClient.private('manual.1').listen('manual.event', (payload) => {
      expectTypeOf(payload).toEqualTypeOf<BroadcastJsonObject>()
    })
    expectTypeOf(defaultClient.presence('manual.1').members).toEqualTypeOf<readonly unknown[]>()
    // @ts-expect-error event exists in the manifest but is not emitted on orders.{orderId}
    client.private('orders.{orderId}').listen('chat.message', () => {})
  })
})
