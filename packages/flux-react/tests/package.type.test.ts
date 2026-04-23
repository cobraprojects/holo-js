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

    const client = createFluxClient({
      manifest,
    })
    if (false) {
      const generic = useFlux('orders.1', 'orders.updated', payload => {
        expectTypeOf(payload).toExtend<Record<string, unknown>>()
      })
      const genericMany = useFlux('orders.1', ['orders.updated', 'orders.shipped'], payload => {
        expectTypeOf(payload).toExtend<Record<string, unknown>>()
      })
      const pub = useFluxPublic('feed.1', 'orders.updated', payload => {
        expectTypeOf(payload).toExtend<Record<string, unknown>>()
      })
      const priv = useFluxPrivate('orders.1', 'orders.shipped', payload => {
        expectTypeOf(payload).toExtend<Record<string, unknown>>()
      })
      const presence = useFluxPresence<{ id: string }>('chat.1', {})
      const status = useFluxConnectionStatus()
      expectTypeOf(presence.members).toEqualTypeOf<readonly { id: string }[]>()
      expectTypeOf(status).toEqualTypeOf<FluxConnectionStatus>()

      void client
      void generic
      void genericMany
      void pub
      void priv
    }
  })
})
