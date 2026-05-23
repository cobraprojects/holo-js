import { describe, it, expectTypeOf } from 'vitest'
import type { FluxConnectionStatus } from '@holo-js/flux'
import { createFluxClient } from '@holo-js/flux'
import type { GeneratedBroadcastManifest } from '@holo-js/broadcast'
import {
  useFlux,
  useFluxConnectionStatus,
  useFluxPresence,
  useFluxPrivate,
  useFluxPublic,
} from '../src'

describe('@holo-js/flux-react typing', () => {
  it('supports single and multi-event typed helper usage', () => {
    const manifest = {
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z' as string,
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
    } as const satisfies GeneratedBroadcastManifest
    const presenceManifest = {
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      events: [{
        name: 'chat.message',
        channels: [{
          type: 'presence',
          pattern: 'chat.{roomId}',
        }],
      }, {
        name: 'orders.updated',
        channels: [{
          type: 'private',
          pattern: 'orders.{orderId}',
        }],
      }],
      channels: [{
        name: 'chat.{roomId}',
        pattern: 'chat.{roomId}',
        type: 'presence',
        params: ['roomId'],
        whispers: [],
        member: {
          id: 'user-1',
          name: 'Ada',
        },
      }, {
        name: 'orders.{orderId}',
        pattern: 'orders.{orderId}',
        type: 'private',
        params: ['orderId'],
        whispers: [],
      }],
    } as const satisfies GeneratedBroadcastManifest

    const client = createFluxClient({
      manifest,
    })
    const presenceClient = createFluxClient({
      manifest: presenceManifest,
    })
    if (false) {
      const generic = useFlux('orders.{orderId}', 'orders.updated', payload => {
        expectTypeOf(payload).toExtend<Record<string, unknown>>()
      }, { client })
      const genericMany = useFlux('orders.{orderId}', ['orders.updated', 'orders.shipped'], payload => {
        expectTypeOf(payload).toExtend<Record<string, unknown>>()
      }, { client })
      const pub = useFluxPublic('feed.1', 'orders.updated', payload => {
        expectTypeOf(payload).toExtend<Record<string, unknown>>()
      })
      const priv = useFluxPrivate('orders.{orderId}', 'orders.shipped', payload => {
        expectTypeOf(payload).toExtend<Record<string, unknown>>()
      }, { client })
      const presence = useFluxPresence('chat.{roomId}', {
        onHere(members) {
          expectTypeOf(members).toEqualTypeOf<readonly {
            readonly id: 'user-1'
            readonly name: 'Ada'
          }[]>()
        },
      }, { client: presenceClient })
      const status = useFluxConnectionStatus()
      expectTypeOf(presence.members).toEqualTypeOf<readonly {
        readonly id: 'user-1'
        readonly name: 'Ada'
      }[]>()
      expectTypeOf(status).toEqualTypeOf<FluxConnectionStatus>()

      // @ts-expect-error event exists in the manifest but is not emitted on orders.{orderId}
      useFlux('orders.{orderId}', 'chat.message', (_payload: Record<string, unknown>) => undefined, { client: presenceClient })
      // @ts-expect-error event is not present in the selected manifest client
      useFlux('orders.{orderId}', 'orders.cancelled', (_payload: Record<string, unknown>) => undefined, { client })
      // @ts-expect-error generated manifest clients only accept known channel patterns
      useFlux('orders.1', 'orders.updated', (_payload: Record<string, unknown>) => undefined, { client })

      void client
      void presenceClient
      void generic
      void genericMany
      void pub
      void priv
    }
  })
})
