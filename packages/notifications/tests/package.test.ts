import { afterEach, describe, expect, it } from 'vitest'
import notifications, {
  deleteNotifications,
  defineNotification,
  defineNotificationsConfig,
  listNotifications,
  markNotificationsAsRead,
  markNotificationsAsUnread,
  notify,
  notifyUsing,
  registerNotificationChannel,
  resetNotificationChannelRegistry,
  unreadNotifications,
} from '../src'

afterEach(() => {
  resetNotificationChannelRegistry()
})

describe('@holo-js/notifications package surface', () => {
  it('exports the package helpers and config helper', () => {
    const definition = defineNotification({
      via() {
        return ['email'] as const
      },
      build: {
        email() {
          return {
            subject: 'Subject',
          }
        },
      },
    })

    expect(typeof notifications.notify).toBe('function')
    expect(typeof notifications.notifyMany).toBe('function')
    expect(typeof notifications.notifyUsing).toBe('function')
    expect(typeof notifications.listNotifications).toBe('function')
    expect(typeof notifications.unreadNotifications).toBe('function')
    expect(typeof notifications.markNotificationsAsRead).toBe('function')
    expect(typeof notifications.markNotificationsAsUnread).toBe('function')
    expect(typeof notifications.deleteNotifications).toBe('function')
    expect(defineNotificationsConfig({
      table: 'notifications',
    })).toEqual({
      table: 'notifications',
    })
    expect(typeof notify({}, definition).then).toBe('function')
    expect(typeof notifyUsing().channel).toBe('function')
    expect(typeof listNotifications).toBe('function')
    expect(typeof unreadNotifications).toBe('function')
    expect(typeof markNotificationsAsRead).toBe('function')
    expect(typeof markNotificationsAsUnread).toBe('function')
    expect(typeof deleteNotifications).toBe('function')
    expect(() => registerNotificationChannel('slack', {
      send() {},
    })).not.toThrow()
  })
})
