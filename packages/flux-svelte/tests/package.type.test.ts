import { describe, expectTypeOf, it } from 'vitest'
import type { Readable } from 'svelte/store'
import type { FluxConnectionStatus } from '@holo-js/flux'
import { createFluxClient, fluxInternals } from '@holo-js/flux'
import type { BroadcastDefinition, BroadcastJsonObject, GeneratedBroadcastManifest } from '@holo-js/broadcast'
import {
  useFlux,
  useFluxConnectionStatus,
  useFluxModel,
  useFluxNotification,
  useFluxPresence,
  useFluxPrivate,
  useFluxPublic,
} from '../src'

declare module '@holo-js/broadcast' {
  interface HoloBroadcastRegistry {
    readonly 'flux.svelte.orders.updated': BroadcastDefinition<'flux.svelte.orders.updated', { orderId: string, status: 'pending' | 'shipped' }>
    readonly 'flux.svelte.orders.shipped': BroadcastDefinition<'flux.svelte.orders.shipped', { orderId: string, shippedAt: string }>
  }
}

describe('@holo-js/flux-svelte typing', () => {
  it('supports single and multi-event typed helper usage', () => {
    const manifest = {
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z' as string,
      events: [{
        name: 'flux.svelte.orders.updated',
        channels: [{
          type: 'private',
          pattern: 'orders.{orderId}',
        }],
      }, {
        name: 'flux.svelte.orders.shipped',
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
        name: 'flux.svelte.chat.message',
        channels: [{
          type: 'presence',
          pattern: 'chat.{roomId}',
        }],
      }, {
        name: 'flux.svelte.orders.updated',
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
        whispers: ['typing.start'],
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
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const presenceClient = createFluxClient({
      manifest: presenceManifest,
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })
    const manualClient = createFluxClient({
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })

    const generic = useFlux('orders.{orderId}', 'flux.svelte.orders.updated', payload => {
      expectTypeOf(payload).toEqualTypeOf<{ orderId: string, status: 'pending' | 'shipped' }>()
    }, { client })
    const genericMany = useFlux('orders.{orderId}', ['flux.svelte.orders.updated', 'flux.svelte.orders.shipped'], payload => {
      expectTypeOf(payload).toEqualTypeOf<{ orderId: string, status: 'pending' | 'shipped' } | { orderId: string, shippedAt: string }>()
    }, { client })
    const pub = useFluxPublic('orders.{orderId}', 'flux.svelte.orders.updated', payload => {
      expectTypeOf(payload).toEqualTypeOf<{ orderId: string, status: 'pending' | 'shipped' }>()
    }, { client })
    const priv = useFluxPrivate('orders.{orderId}', 'flux.svelte.orders.shipped', payload => {
      expectTypeOf(payload).toEqualTypeOf<{ orderId: string, shippedAt: string }>()
    }, { client })
    const model = useFluxModel('orders.{orderId}', 'flux.svelte.orders.updated', payload => {
      expectTypeOf(payload).toEqualTypeOf<{ orderId: string, status: 'pending' | 'shipped' }>()
    }, { client })
    const presence = useFluxPresence('chat.{roomId}', {
      onHere(members) {
        expectTypeOf(members).toEqualTypeOf<readonly {
          readonly id: 'user-1'
          readonly name: 'Ada'
        }[]>()
      },
    }, { client: presenceClient })
    const status = useFluxConnectionStatus({ client })
    const manualPresence = useFluxPresence<{ id: string }>('chat.1', {
      onHere(members) {
        expectTypeOf(members).toEqualTypeOf<readonly { id: string }[]>()
      },
    }, { client: manualClient })
    const defaultPresence = useFluxPresence('chat.1', {
      onHere(members) {
        expectTypeOf(members).toEqualTypeOf<readonly BroadcastJsonObject[]>()
      },
    }, { client: manualClient })
    const notification = useFluxNotification('App.Models.User.1', payload => {
      expectTypeOf(payload).toEqualTypeOf<BroadcastJsonObject>()
    }, { client: manualClient })

    expectTypeOf(presence.members).toEqualTypeOf<Readable<readonly {
      readonly id: 'user-1'
      readonly name: 'Ada'
    }[]>>()
    expectTypeOf(manualPresence.members).toEqualTypeOf<Readable<readonly { id: string }[]>>()
    expectTypeOf(defaultPresence.members).toEqualTypeOf<Readable<readonly BroadcastJsonObject[]>>()
    expectTypeOf(status).toEqualTypeOf<Readable<FluxConnectionStatus>>()

    useFlux('chat.{roomId}', 'flux.svelte.orders.updated', payload => {
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
    expectTypeOf(presenceWithoutMember.members).toEqualTypeOf<Readable<readonly unknown[]>>()

    // @ts-expect-error event exists in the manifest but is not emitted on orders.{orderId}
    useFlux('orders.{orderId}', 'flux.svelte.chat.message', (_payload: BroadcastJsonObject) => undefined, { client: presenceClient })
    // @ts-expect-error event is not present in the selected manifest client
    useFlux('orders.{orderId}', 'flux.svelte.orders.deleted', (_payload: BroadcastJsonObject) => undefined, { client })
    // @ts-expect-error generated manifest clients only accept known channel patterns
    useFlux('orders.1', 'flux.svelte.orders.updated', (_payload: BroadcastJsonObject) => undefined, { client })
    // @ts-expect-error presence members are inferred from known manifest channel patterns
    useFluxPresence('chat.1', {}, { client: presenceClient })

    void generic
    void genericMany
    void pub
    void priv
    void model
    void defaultPresence
    void notification
  })
})
