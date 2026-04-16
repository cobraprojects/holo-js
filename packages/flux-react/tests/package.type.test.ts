import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, it, expectTypeOf } from 'vitest'
import type { FluxConnectionStatus } from '@holo-js/flux'
import { createFluxClient } from '@holo-js/flux'
import {
  useFlux,
  useFluxConnectionStatus,
  useFluxPresence,
  useFluxPrivate,
  useFluxPublic,
} from '../src'

describe('@holo-js/flux-react typing', () => {
  it('supports single and multi-event typed helper usage', async () => {
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
      },
    })
    function Probe() {
      const generic = useFlux('orders.1', 'orders.updated', payload => {
        expectTypeOf(payload).toEqualTypeOf<Record<string, unknown>>()
      }, { client })
      const genericMany = useFlux('orders.1', ['orders.updated', 'orders.shipped'], payload => {
        expectTypeOf(payload).toEqualTypeOf<Record<string, unknown>>()
      }, { client })
      const pub = useFluxPublic('feed.1', 'orders.updated', payload => {
        expectTypeOf(payload).toEqualTypeOf<Record<string, unknown>>()
      }, { client })
      const priv = useFluxPrivate('orders.1', 'orders.shipped', payload => {
        expectTypeOf(payload).toEqualTypeOf<Record<string, unknown>>()
      }, { client })
      const presence = useFluxPresence<{ id: string }>('chat.1', {}, { client })
      const status = useFluxConnectionStatus({ client })
      expectTypeOf(presence.members).toEqualTypeOf<readonly { id: string }[]>()
      expectTypeOf(status).toEqualTypeOf<FluxConnectionStatus>()

      void generic
      void genericMany
      void pub
      void priv
      return null
    }

    await act(async () => {
      const renderer = create(createElement(Probe))
      renderer.unmount()
    })
  })
})
