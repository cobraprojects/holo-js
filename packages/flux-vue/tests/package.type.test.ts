import { describe, expectTypeOf, it } from 'vitest'
import type { FluxConnectionStatus } from '@holo-js/flux'
import { createFluxClient, fluxInternals } from '@holo-js/flux'
import type { BroadcastJsonObject, GeneratedBroadcastManifest } from '@holo-js/broadcast'
import {
  useFlux,
  useFluxConnectionStatus,
  useFluxModel,
  useFluxNotification,
  useFluxPresence,
  useFluxPrivate,
  useFluxPublic,
} from '../src'

describe('@holo-js/flux-vue typing', () => {
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

    const generic = useFlux('orders.{orderId}', 'orders.updated', payload => {
      expectTypeOf(payload).toExtend<Record<string, unknown>>()
    }, { client })
    const genericMany = useFlux('orders.{orderId}', ['orders.updated', 'orders.shipped'], payload => {
      expectTypeOf(payload).toExtend<Record<string, unknown>>()
    }, { client })
    const pub = useFluxPublic('orders.{orderId}', 'orders.updated', payload => {
      expectTypeOf(payload).toExtend<Record<string, unknown>>()
    }, { client })
    const priv = useFluxPrivate('orders.{orderId}', 'orders.shipped', payload => {
      expectTypeOf(payload).toExtend<Record<string, unknown>>()
    }, { client })
    const model = useFluxModel('orders.{orderId}', 'orders.updated', payload => {
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

    expectTypeOf(presence.members).toEqualTypeOf<readonly {
      readonly id: 'user-1'
      readonly name: 'Ada'
    }[]>()
    expectTypeOf(manualPresence.members).toEqualTypeOf<readonly { id: string }[]>()
    expectTypeOf(defaultPresence.members).toEqualTypeOf<readonly BroadcastJsonObject[]>()
    expectTypeOf(status).toExtend<{ readonly value: FluxConnectionStatus }>()

    // @ts-expect-error event exists in the manifest but is not emitted on orders.{orderId}
    useFlux('orders.{orderId}', 'chat.message', (_payload: BroadcastJsonObject) => undefined, { client: presenceClient })
    // @ts-expect-error event is not present in the selected manifest client
    useFlux('orders.{orderId}', 'orders.deleted', (_payload: BroadcastJsonObject) => undefined, { client })
    // @ts-expect-error generated manifest clients only accept known channel patterns
    useFlux('orders.1', 'orders.updated', (_payload: BroadcastJsonObject) => undefined, { client })
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
