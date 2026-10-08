import { describe, it, expectTypeOf } from 'vitest'
import type { FluxConnectionStatus } from '@holo-js/flux'
import { createFluxClient } from '@holo-js/flux'
import type { BroadcastDefinition, BroadcastJsonObject, GeneratedBroadcastManifest } from '@holo-js/broadcast'
import {
  useFlux,
  useFluxConnectionStatus,
  useFluxPresence,
  useFluxPrivate,
  useFluxPublic,
} from '../src'

declare module '@holo-js/broadcast' {
  interface HoloBroadcastRegistry {
    readonly 'flux.react.orders.updated': BroadcastDefinition<'flux.react.orders.updated', { orderId: string, status: 'pending' | 'shipped' }>
    readonly 'flux.react.orders.shipped': BroadcastDefinition<'flux.react.orders.shipped', { orderId: string, shippedAt: string }>
  }
}

describe('@holo-js/flux-react typing', () => {
  it('supports single and multi-event typed helper usage', () => {
    const manifest = {
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z' as string,
      events: [{
        name: 'flux.react.orders.updated',
        channels: [{
          type: 'private',
          pattern: 'orders.{orderId}',
        }],
      }, {
        name: 'flux.react.orders.shipped',
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
        name: 'flux.react.chat.message',
        channels: [{
          type: 'presence',
          pattern: 'chat.{roomId}',
        }],
      }, {
        name: 'flux.react.orders.updated',
        channels: [{
          type: 'private',
          pattern: 'orders.{orderId}',
        }, {
          type: 'presence',
          pattern: 'chat.{roomId}',
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
      const generic = useFlux('orders.{orderId}', 'flux.react.orders.updated', payload => {
        expectTypeOf(payload).toEqualTypeOf<{ orderId: string, status: 'pending' | 'shipped' }>()
      }, { client })
      const genericMany = useFlux('orders.{orderId}', ['flux.react.orders.updated', 'flux.react.orders.shipped'], payload => {
        expectTypeOf(payload).toEqualTypeOf<{ orderId: string, status: 'pending' | 'shipped' } | { orderId: string, shippedAt: string }>()
      }, { client })
      const pub = useFluxPublic('feed.1', 'flux.react.orders.updated', payload => {
        expectTypeOf(payload).toEqualTypeOf<{ orderId: string, status: 'pending' | 'shipped' }>()
      })
      const priv = useFluxPrivate('orders.{orderId}', 'flux.react.orders.shipped', payload => {
        expectTypeOf(payload).toEqualTypeOf<{ orderId: string, shippedAt: string }>()
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

      useFlux('chat.{roomId}', 'flux.react.orders.updated', payload => {
        expectTypeOf(payload).toEqualTypeOf<{ orderId: string, status: 'pending' | 'shipped' }>()
        // @ts-expect-error payload is inferred from the registered event definition
        const shippedAt: string = payload.shippedAt
        void shippedAt
      }, { client: presenceClient })
      const presenceWithoutMember = useFluxPresence('orders.{orderId}', {
        onHere(members) {
          expectTypeOf(members).toEqualTypeOf<readonly unknown[]>()
        },
      }, { client })
      expectTypeOf(presenceWithoutMember.members).toEqualTypeOf<readonly unknown[]>()
      const defaultPresence = useFluxPresence('manual.1', { onHere(members) {
        expectTypeOf(members).toEqualTypeOf<readonly BroadcastJsonObject[]>()
      } })
      const explicitPresence = useFluxPresence<{ id: string }>('manual.1', { onHere(members) {
        expectTypeOf(members).toEqualTypeOf<readonly { id: string }[]>()
      } })
      expectTypeOf(defaultPresence.members).toEqualTypeOf<readonly BroadcastJsonObject[]>()
      expectTypeOf(explicitPresence.members).toEqualTypeOf<readonly { id: string }[]>()
      // @ts-expect-error generated manifest presence hooks accept known patterns only
      useFluxPresence('chat.1', {}, { client: presenceClient })

      // @ts-expect-error event exists in the manifest but is not emitted on orders.{orderId}
      useFlux('orders.{orderId}', 'flux.react.chat.message', (_payload: Record<string, unknown>) => undefined, { client: presenceClient })
      // @ts-expect-error event is not present in the selected manifest client
      useFlux('orders.{orderId}', 'flux.react.orders.cancelled', (_payload: Record<string, unknown>) => undefined, { client })
      // @ts-expect-error generated manifest clients only accept known channel patterns
      useFlux('orders.1', 'flux.react.orders.updated', (_payload: Record<string, unknown>) => undefined, { client })

      void client
      void presenceClient
      void generic
      void genericMany
      void pub
      void priv
    }
  })
})
