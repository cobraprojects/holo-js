import { expect, it } from 'vitest'
import { createFluxClient } from '../src'

it('requires an explicit connector before subscriptions can be created', () => {
    const client = createFluxClient()

    expect(client.status).toBe('idle')
    expect(() => client.channel('orders.1')).toThrow('No realtime connector configured')
    expect(() => client.private('orders.1')).toThrow('No realtime connector configured')
    expect(() => client.presence('chat.1')).toThrow('No realtime connector configured')
  })
