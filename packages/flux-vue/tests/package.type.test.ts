import { describe, expectTypeOf, it } from 'vitest'
import type { FluxConnectionStatus } from '@holo-js/flux'
import { createFluxClient, fluxInternals } from '@holo-js/flux'
import type { GeneratedBroadcastManifest } from '@holo-js/broadcast'
import {
  useFlux,
  useFluxConnectionStatus,
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

    const client = createFluxClient({
      manifest,
      connector: fluxInternals.createPusherConnector({ transport: 'mock' }),
    })

    const generic = useFlux('orders.1', 'orders.updated', payload => {
      expectTypeOf(payload).toExtend<Record<string, unknown>>()
    }, { client })
    const genericMany = useFlux('orders.1', ['orders.updated', 'orders.shipped'], payload => {
      expectTypeOf(payload).toExtend<Record<string, unknown>>()
    }, { client })
    const pub = useFluxPublic('feed.1', 'orders.updated', payload => {
      expectTypeOf(payload).toExtend<Record<string, unknown>>()
    }, { client })
    const priv = useFluxPrivate('orders.1', 'orders.shipped', payload => {
      expectTypeOf(payload).toExtend<Record<string, unknown>>()
    }, { client })
    const presence = useFluxPresence('chat.1', {
      onHere(members: readonly { id: string }[]) {
        void members
      },
    }, { client })
    const status = useFluxConnectionStatus({ client })
    expectTypeOf(presence.members).toEqualTypeOf<readonly { id: string }[]>()
    expectTypeOf(status).toExtend<{ readonly value: FluxConnectionStatus }>()

    void generic
    void genericMany
    void pub
    void priv
  })
})
