import { describe, expect, it } from 'vitest'
import { defineSchema, field } from '@holo-js/validation'
import {
  broadcastInternals,
  channel,
  defineBroadcast,
  defineChannel,
  isBroadcastDefinition,
  isChannelDefinition,
  presenceChannel,
  privateChannel,
} from '../src'

describe('@holo-js/broadcast contracts', () => {
  it('normalizes broadcast definitions and channel targets', () => {
    const definition = defineBroadcast({
      name: ' orders.updated ',
      channels: () => [
        privateChannel('orders.{orderId}', { orderId: 42 }),
        presenceChannel('chat.{roomId}', { roomId: 'room_1' }),
        channel('dashboard'),
      ],
      payload: {
        orderId: 'ord_1',
        status: 'shipped',
        meta: {
          retried: false,
        },
      },
      queue: {
        queued: true,
        connection: ' redis ',
        queue: ' realtime ',
        afterCommit: true,
      },
      delay: 5,
    })

    expect(isBroadcastDefinition(definition)).toBe(true)
    expect(broadcastInternals.hasBroadcastDefinitionMarker(definition)).toBe(true)
    expect(definition).toEqual({
      name: 'orders.updated',
      channels: [
        {
          type: 'private',
          pattern: 'orders.{orderId}',
          params: {
            orderId: '42',
          },
        },
        {
          type: 'presence',
          pattern: 'chat.{roomId}',
          params: {
            roomId: 'room_1',
          },
        },
        {
          type: 'public',
          pattern: 'dashboard',
          params: {},
        },
      ],
      payload: {
        orderId: 'ord_1',
        status: 'shipped',
        meta: {
          retried: false,
        },
      },
      queue: {
        queued: true,
        connection: 'redis',
        queue: 'realtime',
        afterCommit: true,
      },
      delay: 5,
    })
    expect(Object.isFrozen(definition)).toBe(true)
    expect(broadcastInternals.formatChannelPattern('orders.{orderId}', { orderId: 'ord_1' })).toBe('orders.ord_1')
    expect(defineBroadcast({
      name: 'orders.boolean',
      channels: [channel('dashboard')],
      payload: () => ({
        ok: true,
      }),
      queue: true,
    }).queue).toEqual({
      queued: true,
      afterCommit: false,
    })
    expect(defineBroadcast({
      name: 'orders.date',
      channels: [channel('dashboard')],
      payload: {
        ok: true,
      },
      delay: new Date(0),
    }).delay).toEqual(new Date(0))
    expect(defineBroadcast({
      name: 'orders.no-delay',
      channels: [channel('dashboard')],
      payload: {
        ok: true,
      },
      delay: undefined,
    }).delay).toBeUndefined()
  })

  it('normalizes channel definitions and whisper allowlists', () => {
    const typingSchema = defineSchema({
      editing: field.boolean().required(),
    })

    const definition = defineChannel('chat.{roomId}', {
      type: 'presence',
      authorize() {
        return {
          id: 'user_1',
          name: 'Ava',
        }
      },
      whispers: {
        'typing.start': typingSchema,
      },
    })

    expect(isChannelDefinition(definition)).toBe(true)
    expect(broadcastInternals.hasChannelDefinitionMarker(definition)).toBe(true)
    expect(definition.pattern).toBe('chat.{roomId}')
    expect(definition.type).toBe('presence')
    expect(Object.keys(definition.whispers)).toEqual(['typing.start'])
    expect(broadcastInternals.extractChannelPatternParamNames('chat.{roomId}')).toEqual(['roomId'])
    expect(Object.isFrozen(definition.whispers)).toBe(true)
  })

  it('rejects invalid queue, channel, and whisper definitions', () => {
    expect(() => defineBroadcast(null as never)).toThrow('must be plain objects')

    expect(() => defineBroadcast({
      channels: [],
      payload: {
        ok: true,
      },
    } as never)).toThrow('at least one channel')

    expect(() => defineBroadcast({
      channels: [null],
      payload: {
        ok: true,
      },
    } as never)).toThrow('created through channel helpers')

    expect(() => defineBroadcast({
      channels: [channel('orders.{orderId}')],
      payload: {
        ok: true,
      },
    })).toThrow('must define param "orderId"')
    expect(() => channel('orders.{orderId}', {
      orderId: 'ord_1',
      extra: 'nope',
    })).toThrow('does not define param "extra"')
    expect(() => channel('orders.{orderId}', {
      ' ': 'ord_1',
    } as never)).toThrow('must not include empty keys')
    expect(() => broadcastInternals.formatChannelPattern('orders.{orderId}', {} as never)).toThrow('missing param "orderId"')

    expect(() => defineBroadcast({
      channels: [channel('dashboard')],
      payload: {
        ok: true,
      },
      queue: {
        connection: 'redis',
      },
    })).toThrow('requires queued: true')
    expect(() => defineBroadcast({
      channels: [channel('dashboard')],
      payload: {
        ok: true,
      },
      queue: {
        queue: 'realtime',
      },
    })).toThrow('requires queued: true')
    expect(() => defineBroadcast({
      channels: [channel('dashboard')],
      payload: {
        ok: true,
      },
      queue: {
        afterCommit: true,
      },
    })).toThrow('requires queued: true')

    expect(() => defineBroadcast({
      channels: [channel('dashboard')],
      payload: {
        invalid: new Map(),
      } as never,
    })).toThrow('JSON-serializable')
    expect(() => defineBroadcast({
      channels: [channel('dashboard')],
      payload: {
        ok: true,
      },
      delay: -1,
    })).toThrow('greater than or equal to 0')
    expect(() => defineBroadcast({
      channels: [channel('dashboard')],
      payload: {
        ok: true,
      },
      delay: new Date(Number.NaN),
    })).toThrow('valid Date instances')
    expect(() => defineBroadcast({
      channels: [channel('dashboard')],
      payload: {
        '': true,
      } as never,
    })).toThrow('must not include empty payload keys')
    expect(() => defineBroadcast({
      channels: [channel('dashboard')],
      payload: 'invalid' as never,
    })).toThrow('must be a plain object')

    expect(() => defineChannel('orders.{orderId}', {
      type: 'private',
    } as never)).toThrow('must define an authorize')

    expect(() => defineChannel('orders.{orderId}', {
      type: 'private',
      authorize() {
        return true
      },
      whispers: {
        broken: {} as never,
      },
    })).toThrow('must be a validation schema')
    expect(() => defineChannel('orders.{orderId}', {
      type: 'private',
      authorize() {
        return true
      },
      whispers: {
        '': defineSchema({
          editing: field.boolean().required(),
        }),
      } as never,
    })).toThrow('must be a non-empty string')

    expect(() => defineChannel('orders.{orderId}', {
      type: 'public' as never,
      authorize() {
        return true
      },
    })).toThrow('must use type "private" or "presence"')

    expect(() => broadcastInternals.extractChannelPatternParamNames('orders.{orderId}.{orderId}')).toThrow('duplicate params')
    expect(() => broadcastInternals.normalizeChannelPattern('orders.$bad')).toThrow('invalid segment')
    expect(() => broadcastInternals.normalizeChannelPattern('orders..bad')).toThrow('empty path segments')
    expect(() => broadcastInternals.normalizeChannelPattern(undefined as unknown as string)).toThrow('must be a non-empty string')
  })
})
