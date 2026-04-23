import { describe, expect, it } from 'vitest'
import {
  defineNotification,
  isNotificationDefinition,
  notificationsInternals,
} from '../src'

describe('@holo-js/notifications contracts', () => {
  it('normalizes and freezes notification definitions', () => {
    const definition = defineNotification({
      type: ' invoice.paid ',
      via() {
        return ['email', 'database'] as const
      },
      build: {
        email() {
          return {
            subject: 'Invoice paid',
            lines: ['Invoice settled.'],
          }
        },
        database() {
          return {
            data: {
              invoiceId: 'inv-1',
            },
          }
        },
      },
      queue: {
        connection: ' redis ',
        queue: ' notifications ',
        delay: 10,
        afterCommit: true,
      },
      delay: {
        email: 60,
      },
    })

    expect(isNotificationDefinition(definition)).toBe(true)
    expect(definition.type).toBe('invoice.paid')
    expect(definition.queue).toEqual({
      connection: 'redis',
      queue: 'notifications',
      delay: 10,
      afterCommit: true,
    })
    expect(definition.delay).toEqual({
      email: 60,
    })
    expect(Object.isFrozen(definition)).toBe(true)
    expect(Object.isFrozen(definition.build)).toBe(true)
  })

  it('rejects malformed definitions, delays, and queue options', () => {
    expect(() => defineNotification({
      via() {
        return ['email'] as never
      },
      build: {},
    })).toThrow('must define at least one channel payload builder')

    expect(() => defineNotification({
      via() {
        return ['email'] as const
      },
      build: {
        email: 'broken' as never,
      },
    })).toThrow('must be a function')

    expect(() => defineNotification({
      type: '   ',
      via() {
        return ['email'] as const
      },
      build: {
        email() {
          return {
            subject: 'Broken',
          }
        },
      },
    })).toThrow('Notification type must be a non-empty string')

    expect(() => defineNotification({
      via() {
        return ['email'] as const
      },
      build: {
        email() {
          return {
            subject: 'Broken',
          }
        },
      },
      queue: {
        connection: '   ',
      },
    })).toThrow('Notification queue connection')

    expect(() => defineNotification({
      via() {
        return ['email'] as const
      },
      build: {
        email() {
          return {
            subject: 'Broken',
          }
        },
      },
      delay: {
        email: -1,
      },
    })).toThrow('greater than or equal to 0')

    expect(() => notificationsInternals.normalizeDelayValue(new Date('invalid'), 'Notification delay'))
      .toThrow('valid Date instances')
  })

  it('covers internal normalization helpers and alternate notification shapes', () => {
    const queueResolver = () => true
    const delayResolver = () => 30
    const queueDefinition = notificationsInternals.normalizeNotificationDefinition({
      via() {
        return ['email'] as const
      },
      build: {
        email() {
          return {
            subject: 'Hello',
          }
        },
      },
      queue: queueResolver,
      delay: delayResolver,
    })

    expect(queueDefinition.queue).toBe(queueResolver)
    expect(queueDefinition.delay).toBe(delayResolver)
    expect(defineNotification({
      via() {
        return ['email'] as const
      },
      build: {
        email() {
          return {
            subject: 'Queued',
          }
        },
      },
      queue: true,
    }).queue).toBe(true)
    expect(notificationsInternals.normalizeDelayConfig(15)).toBe(15)
    expect(notificationsInternals.normalizeDelayConfig(new Date('2026-01-01T00:00:00.000Z'))).toEqual(
      new Date('2026-01-01T00:00:00.000Z'),
    )
    expect(notificationsInternals.normalizeQueueOptions({
      afterCommit: false,
    })).toEqual({
      afterCommit: false,
    })
    expect(notificationsInternals.normalizeQueueOptions({
      queue: 'notifications',
    })).toEqual({
      connection: undefined,
      queue: 'notifications',
    })
    expect(notificationsInternals.normalizeOptionalBoolean(undefined, 'flag')).toBeUndefined()
    expect(notificationsInternals.normalizeOptionalBoolean(false, 'flag')).toBe(false)
    expect(notificationsInternals.normalizeOptionalString(undefined, 'label')).toBeUndefined()
    expect(() => notificationsInternals.normalizeOptionalBoolean('yes' as never, 'flag')).toThrow('must be a boolean')
    expect(() => notificationsInternals.normalizeDelayConfig('broken' as never)).toThrow('must be a number, Date, plain object, or function')
    expect(() => notificationsInternals.normalizeNotificationDefinition('broken' as never)).toThrow('must define via() and build')
    expect(notificationsInternals.createAnonymousNotificationTarget({
      email: 'ava@example.com',
    })).toEqual({
      anonymous: true,
      routes: {
        email: 'ava@example.com',
      },
    })
    expect(notificationsInternals.isObject({ ok: true })).toBe(true)
    expect(notificationsInternals.isObject(null)).toBe(false)
  })
})
