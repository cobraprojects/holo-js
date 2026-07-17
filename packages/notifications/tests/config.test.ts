import { describe, expect, it } from 'vitest'
import {
  defineNotificationsConfig,
  holoNotificationsDefaults,
  normalizeNotificationsConfig,
} from '../src'

describe('@holo-js/notifications config', () => {
  it('owns config definition, defaults, and normalization', () => {
    const config = defineNotificationsConfig({
      table: ' app_notifications ',
      queue: {
        connection: ' redis ',
        queue: ' alerts ',
        afterCommit: true,
      },
    })

    expect(Object.isFrozen(config)).toBe(true)
    expect(normalizeNotificationsConfig(config)).toEqual({
      table: 'app_notifications',
      queue: {
        connection: 'redis',
        queue: 'alerts',
        afterCommit: true,
      },
    })
    expect(normalizeNotificationsConfig()).toEqual(holoNotificationsDefaults)
  })

  it('rejects blank names at the feature boundary', () => {
    expect(() => normalizeNotificationsConfig({ table: ' ' })).toThrow('Notifications table')
    expect(() => normalizeNotificationsConfig({ queue: { connection: ' ' } })).toThrow('Notifications queue connection')
    expect(() => normalizeNotificationsConfig({ queue: { queue: ' ' } })).toThrow('Notifications queue name')
  })
})
