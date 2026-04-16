import { afterEach, describe, expect, it } from 'vitest'
import * as broadcastExports from '../src'
import broadcast, {
  authorizeBroadcastChannel,
  broadcastRaw,
  broadcastAuthInternals,
  broadcastInternals,
  configureBroadcastRuntime,
  channel,
  defineBroadcast,
  defineBroadcastConfig,
  defineChannel,
  getBroadcastRuntime,
  getBroadcastRuntimeBindings,
  parseBroadcastAuthEndpointPayload,
  getRegisteredBroadcastDriver,
  isBroadcastDefinition,
  isChannelDefinition,
  listRegisteredBroadcastDrivers,
  presenceChannel,
  privateChannel,
  registerBroadcastDriver,
  renderBroadcastAuthResponse,
  resolveBroadcastWhisperSchema,
  resetBroadcastDriverRegistry,
  resetBroadcastRuntime,
  validateBroadcastWhisperPayload,
} from '../src'

afterEach(() => {
  broadcastAuthInternals.reset()
  resetBroadcastDriverRegistry()
  resetBroadcastRuntime()
})

describe('@holo-js/broadcast package surface', () => {
  it('exports the public contracts, helpers, and driver registry seam', () => {
    expect(defineBroadcastConfig({
      default: 'null',
      connections: {
        null: {
          driver: 'null',
        },
      },
    })).toEqual({
      default: 'null',
      connections: {
        null: {
          driver: 'null',
        },
      },
    })

    expect(channel('orders.{orderId}', { orderId: 1 })).toEqual({
      type: 'public',
      pattern: 'orders.{orderId}',
      params: {
        orderId: '1',
      },
    })
    expect(privateChannel('orders.{orderId}', { orderId: 'ord_1' }).type).toBe('private')
    expect(presenceChannel('chat.{roomId}', { roomId: 'room-1' }).type).toBe('presence')
    expect(defineBroadcast({
      name: 'orders.updated',
      channels: [privateChannel('orders.{orderId}', { orderId: 'ord_1' })],
      payload: {
        orderId: 'ord_1',
      },
    })).toSatisfy(isBroadcastDefinition)
    const channelDefinition = defineChannel('orders.{orderId}', {
      type: 'private',
      authorize() {
        return true
      },
    })
    expect(channelDefinition.pattern).toBe('orders.{orderId}')
    expect(isChannelDefinition(channelDefinition)).toBe(true)
    expect(broadcastInternals.extractChannelPatternParamNames('orders.{orderId}')).toEqual(['orderId'])
    expect(typeof broadcast.defineBroadcast).toBe('function')
    expect(typeof broadcast.broadcast).toBe('function')
    expect(typeof broadcastRaw).toBe('function')
    expect(typeof authorizeBroadcastChannel).toBe('function')
    expect(typeof renderBroadcastAuthResponse).toBe('function')
    expect(typeof parseBroadcastAuthEndpointPayload).toBe('function')
    expect(typeof resolveBroadcastWhisperSchema).toBe('function')
    expect(typeof validateBroadcastWhisperPayload).toBe('function')
    configureBroadcastRuntime()
    expect(getBroadcastRuntimeBindings()).toEqual({})
    expect(typeof getBroadcastRuntime().broadcast).toBe('function')
    expect(() => registerBroadcastDriver('custom', {
      send(input, context) {
        return {
          connection: context.connection,
          driver: context.driver,
          queued: context.queued,
          publishedChannels: input.channels,
        }
      },
    })).not.toThrow()
    expect(listRegisteredBroadcastDrivers()).toHaveLength(1)
    expect(getRegisteredBroadcastDriver('custom')).toBeTypeOf('object')
    expect(() => registerBroadcastDriver('custom', {
      send() {
        return {
          connection: 'broadcast',
          driver: 'custom',
          queued: false,
          publishedChannels: [],
        }
      },
    })).toThrow('already registered')
    expect(() => registerBroadcastDriver('custom', {
      send() {
        return {
          connection: 'broadcast',
          driver: 'custom',
          queued: false,
          publishedChannels: [],
        }
      },
    }, { replace: true })).not.toThrow()
    expect(() => registerBroadcastDriver('  ' as never, {
      send() {
        return {
          connection: 'broadcast',
          driver: 'custom',
          queued: false,
          publishedChannels: [],
        }
      },
    })).toThrow('must be non-empty strings')
    expect(() => registerBroadcastDriver('broken', {} as never)).toThrow('must define a send')
    expect(() => getRegisteredBroadcastDriver('   ' as never)).toThrow('must be non-empty strings')
    expect('Pusher' in broadcastExports).toBe(false)
    expect('createServer' in broadcastExports).toBe(false)
  })
})
