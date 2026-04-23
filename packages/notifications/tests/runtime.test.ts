import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureNotificationsRuntime,
  defineNotification,
  getNotificationsRuntimeBindings,
  getNotificationsRuntime,
  getRegisteredNotificationChannel,
  listRegisteredNotificationChannels,
  notificationsRuntimeInternals,
  notify,
  notifyMany,
  notifyUsing,
  listNotifications,
  unreadNotifications,
  markNotificationsAsRead,
  markNotificationsAsUnread,
  deleteNotifications,
  registerNotificationChannel,
  resetNotificationChannelRegistry,
  resetNotificationsRuntime,
  type NotificationChannel,
  type NotificationBuildFactories,
  type NotificationDefinition,
} from '../src'

type InvoicePaidNotifiable = {
  readonly id?: string
  readonly type?: string
  readonly email: string
  readonly name?: string
  readonly routeNotificationForBroadcast?: () => readonly string[]
}

declare module '../src/contracts' {
  interface HoloNotificationChannelRegistry {
    readonly slack: NotificationChannel<{ readonly webhook: string }, { readonly text: string }, void>
  }
}

function asRuntimeNotification<TNotifiable, TBuild extends NotificationBuildFactories<TNotifiable>>(
  notification: NotificationDefinition<TNotifiable, TBuild>,
): NotificationDefinition<unknown, NotificationBuildFactories<unknown>> {
  return notification as unknown as NotificationDefinition<unknown, NotificationBuildFactories<unknown>>
}

const invoicePaidDefinition: NotificationDefinition<
  InvoicePaidNotifiable,
  NotificationBuildFactories<InvoicePaidNotifiable>
> = {
  type: 'invoice-paid',
  via() {
    return ['email', 'database', 'broadcast'] as const
  },
  build: {
    email(user: { email: string }) {
      return {
        subject: `Invoice paid for ${user.email}`,
      }
    },
    database() {
      return {
        data: {
          invoiceId: 'inv-1',
        },
      }
    },
    broadcast() {
      return {
        event: 'notifications.invoice-paid',
        data: {
          invoiceId: 'inv-1',
        },
      }
    },
  },
}

const invoicePaid = defineNotification(invoicePaidDefinition)

function createQueueModuleStub() {
  const jobs = new Map<string, { handle(payload: unknown): Promise<unknown> | unknown }>()
  const dispatches: Array<{
    jobName: string
    payload: unknown
    connection?: string
    queue?: string
    delay?: number | Date
  }> = []

  return {
    jobs,
    dispatches,
    module: {
      defineJob(definition: { handle(payload: unknown): Promise<unknown> | unknown }) {
        return definition
      },
      getRegisteredQueueJob(name: string) {
        return jobs.get(name)
      },
      registerQueueJob(definition: { handle(payload: unknown): Promise<unknown> | unknown }, options: { name: string }) {
        jobs.set(options.name, definition)
      },
      dispatch(jobName: string, payload: unknown) {
        const entry: {
          jobName: string
          payload: unknown
          connection?: string
          queue?: string
          delay?: number | Date
        } = {
          jobName,
          payload,
        }

        return {
          onConnection(name: string) {
            entry.connection = name
            return this
          },
          onQueue(name: string) {
            entry.queue = name
            return this
          },
          delay(value: number | Date) {
            entry.delay = value
            return this
          },
          async dispatch() {
            dispatches.push({ ...entry })
            return await jobs.get(jobName)?.handle(payload)
          },
        }
      },
    },
  }
}

afterEach(() => {
  resetNotificationsRuntime()
  resetNotificationChannelRegistry()
})

describe('@holo-js/notifications runtime', () => {
  it('keeps custom dispatch lazy until awaited and forwards fluent options', async () => {
    const dispatch = vi.fn(async (input) => ({
      totalTargets: input.target.kind === 'many' ? (input.target.value as readonly unknown[]).length : 1,
      channels: [],
    }))

    configureNotificationsRuntime({ dispatch })

    const pending = notify({ id: 'user-1', email: 'ava@example.com' }, invoicePaid)
      .onConnection('redis')
      .onQueue('notifications')
      .delay(15)
      .delayFor('email', 60)
      .afterCommit()

    expect(dispatch).not.toHaveBeenCalled()

    await expect(pending).resolves.toEqual({
      totalTargets: 1,
      channels: [],
    })

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      target: {
        kind: 'notifiable',
        value: { id: 'user-1', email: 'ava@example.com' },
      },
      options: {
        connection: 'redis',
        queue: 'notifications',
        delay: 15,
        delayByChannel: {
          email: 60,
        },
        afterCommit: true,
      },
    }))
  })

  it('dispatches built-in channels and aggregates per-channel results', async () => {
    const mailer = {
      send: vi.fn(async () => {}),
    }
    const broadcaster = {
      send: vi.fn(async () => {}),
    }
    const store = {
      create: vi.fn(async () => {}),
      list: vi.fn(),
      unread: vi.fn(),
      markAsRead: vi.fn(),
      markAsUnread: vi.fn(),
      delete: vi.fn(),
    }

    configureNotificationsRuntime({
      mailer,
      broadcaster,
      store,
    })

    const result = await notify({
      id: 'user-1',
      type: 'users',
      email: 'ava@example.com',
      name: 'Ava',
      routeNotificationForBroadcast: () => ['private-users.user-1'],
    }, invoicePaid)

    expect(result.totalTargets).toBe(1)
    expect(result.channels).toEqual([
      { channel: 'email', targetIndex: 0, queued: false, success: true },
      { channel: 'database', targetIndex: 0, queued: false, success: true },
      { channel: 'broadcast', targetIndex: 0, queued: false, success: true },
    ])
    expect(mailer.send).toHaveBeenCalledWith({
      subject: 'Invoice paid for ava@example.com',
    }, expect.objectContaining({
      channel: 'email',
      route: {
        email: 'ava@example.com',
        name: 'Ava',
      },
      targetIndex: 0,
    }))
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'invoice-paid',
      notifiableType: 'users',
      notifiableId: 'user-1',
      data: {
        invoiceId: 'inv-1',
      },
      readAt: null,
    }))
    expect(broadcaster.send).toHaveBeenCalledWith({
      event: 'notifications.invoice-paid',
      data: {
        invoiceId: 'inv-1',
      },
    }, expect.objectContaining({
      channel: 'broadcast',
      route: ['private-users.user-1'],
      targetIndex: 0,
    }))
  })

  it('supports anonymous targets through notifyUsing()', async () => {
    const mailer = {
      send: vi.fn(async () => {}),
    }
    const broadcaster = {
      send: vi.fn(async () => {}),
    }
    const store = {
      create: vi.fn(async () => {}),
      list: vi.fn(),
      unread: vi.fn(),
      markAsRead: vi.fn(),
      markAsUnread: vi.fn(),
      delete: vi.fn(),
    }

    configureNotificationsRuntime({
      mailer,
      broadcaster,
      store,
    })

    const result = await notifyUsing()
      .channel('email', { email: 'ava@example.com', name: 'Ava' })
      .channel('database', { id: 'user-1', type: 'users' })
      .channel('broadcast', { channels: ['private-users.user-1'] })
      .notify(asRuntimeNotification(invoicePaid))

    expect(result.channels).toHaveLength(3)
    expect(mailer.send).toHaveBeenCalledWith({
      subject: 'Invoice paid for undefined',
    }, expect.objectContaining({
      anonymous: true,
      route: {
        email: 'ava@example.com',
        name: 'Ava',
      },
    }))
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({
      notifiableType: 'users',
      notifiableId: 'user-1',
    }))
    expect(broadcaster.send).toHaveBeenCalledWith({
      event: 'notifications.invoice-paid',
      data: {
        invoiceId: 'inv-1',
      },
    }, expect.objectContaining({
      route: {
        channels: ['private-users.user-1'],
      },
      anonymous: true,
    }))
  })

  it('exposes typed database notification read and mutation helpers through the configured store', async () => {
    const listed = [
      {
        id: 'notif-1',
        type: 'invoice-paid',
        notifiableType: 'users',
        notifiableId: 'user-1',
        data: { invoiceId: 'inv-1' },
        readAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ] as const
    const unread = [
      {
        id: 'notif-2',
        type: 'invoice-paid',
        notifiableType: 'users',
        notifiableId: 'user-1',
        data: { invoiceId: 'inv-2' },
        readAt: null,
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ] as const
    const store = {
      create: vi.fn(async () => {}),
      list: vi.fn(async () => listed),
      unread: vi.fn(async () => unread),
      markAsRead: vi.fn(async () => 2),
      markAsUnread: vi.fn(async () => 1),
      delete: vi.fn(async () => 3),
    }

    configureNotificationsRuntime({ store })

    await expect(listNotifications({ id: 'user-1', type: 'users' })).resolves.toEqual(listed)
    await expect(unreadNotifications({ id: 'user-1', type: 'users' })).resolves.toEqual(unread)
    await expect(markNotificationsAsRead([' notif-1 ', 'notif-2', 'notif-1'])).resolves.toBe(2)
    await expect(markNotificationsAsUnread(['notif-3'])).resolves.toBe(1)
    await expect(deleteNotifications(['notif-4', 'notif-5'])).resolves.toBe(3)

    expect(store.list).toHaveBeenCalledWith({ id: 'user-1', type: 'users' })
    expect(store.unread).toHaveBeenCalledWith({ id: 'user-1', type: 'users' })
    expect(store.markAsRead).toHaveBeenCalledWith(['notif-1', 'notif-2'])
    expect(store.markAsUnread).toHaveBeenCalledWith(['notif-3'])
    expect(store.delete).toHaveBeenCalledWith(['notif-4', 'notif-5'])
  })

  it('rejects missing or invalid anonymous built-in routes', async () => {
    configureNotificationsRuntime({
      mailer: {
        send: vi.fn(async () => {}),
      },
      store: {
        create: vi.fn(async () => {}),
        list: vi.fn(),
        unread: vi.fn(),
        markAsRead: vi.fn(),
        markAsUnread: vi.fn(),
        delete: vi.fn(),
      },
      broadcaster: {
        send: vi.fn(async () => {}),
      },
    })

    await expect(notifyUsing()
      .channel('email', { email: 'ava@example.com' })
      .notify(asRuntimeNotification(invoicePaid))).resolves.toMatchObject({
      totalTargets: 1,
    })

    await expect(notifyUsing()
      .channel('email', { email: 'ava@example.com' })
      .notify({
        via() {
          return ['email', 'database'] as const
        },
        build: {
          email() {
            return {
              subject: 'Hello',
            }
          },
          database() {
            return {
              data: {
                ok: true,
              },
            }
          },
        },
      })).resolves.toMatchObject({
      channels: [
        {
          channel: 'email',
          success: true,
        },
        expect.objectContaining({
          channel: 'database',
          success: false,
          error: expect.any(Error),
        }),
      ],
    })

    const invalidDatabaseRoute = await notifyUsing()
      .channel('email', { email: 'ava@example.com' })
      .channel('database', { id: 'user-1', type: '   ' } as never)
      .notify(asRuntimeNotification(invoicePaid))

    expect((invalidDatabaseRoute.channels[1] as { error: Error }).error.message)
      .toContain('Database routes must include a string or numeric id and a non-empty type')
  })

  it('returns partial failures instead of failing fast', async () => {
    configureNotificationsRuntime({
      mailer: {
        send: vi.fn(async () => {
          throw new Error('mail failed')
        }),
      },
      store: {
        create: vi.fn(async () => {}),
        list: vi.fn(),
        unread: vi.fn(),
        markAsRead: vi.fn(),
        markAsUnread: vi.fn(),
        delete: vi.fn(),
      },
      broadcaster: {
        send: vi.fn(async () => {}),
      },
    })

    const result = await notify({
      id: 'user-1',
      type: 'users',
      email: 'ava@example.com',
      routeNotificationForBroadcast: () => ['private-users.user-1'],
    }, invoicePaid)

    expect(result.channels).toHaveLength(3)
    expect(result.channels[0]).toMatchObject({
      channel: 'email',
      targetIndex: 0,
      queued: false,
      success: false,
    })
    expect(result.channels[1]).toEqual({
      channel: 'database',
      targetIndex: 0,
      queued: false,
      success: true,
    })
    expect(result.channels[2]).toEqual({
      channel: 'broadcast',
      targetIndex: 0,
      queued: false,
      success: true,
    })
  })

  it('reports missing builders as per-channel failures and rejects unknown channels', async () => {
    configureNotificationsRuntime({
      mailer: {
        send: vi.fn(async () => {}),
      },
    })

    const missingBuilder = await notify({
      email: 'ava@example.com',
    }, {
      via() {
        return ['email', 'database'] as const
      },
      build: {
        email() {
          return {
            subject: 'Hello',
          }
        },
      },
    })

    expect(missingBuilder.channels).toEqual([
      {
        channel: 'email',
        targetIndex: 0,
        queued: false,
        success: true,
      },
      expect.objectContaining({
        channel: 'database',
        targetIndex: 0,
        queued: false,
        success: false,
        error: expect.any(Error),
      }),
    ])
    expect((missingBuilder.channels[1] as { error: Error }).error.message).toContain('has no build.database() payload factory')

    await expect(notify({
      email: 'ava@example.com',
    } as never, {
      via() {
        return ['sms'] as const
      },
      build: {
        sms() {
          return {
            body: 'Hello',
          }
        },
      },
    } as never)).rejects.toThrow('is not registered')
  })

  it('queues notifications per channel and resolves delay and queue precedence', async () => {
    const mailer = {
      send: vi.fn(async () => {}),
    }
    const store = {
      create: vi.fn(async () => {}),
      list: vi.fn(),
      unread: vi.fn(),
      markAsRead: vi.fn(),
      markAsUnread: vi.fn(),
      delete: vi.fn(),
    }
    const broadcaster = {
      send: vi.fn(async () => {}),
    }
    const queue = createQueueModuleStub()

    notificationsRuntimeInternals.setQueueModuleLoader(async () => queue.module)
    configureNotificationsRuntime({
      mailer,
      store,
      broadcaster,
      config: {
        table: 'notifications',
        queue: {
          connection: 'config-connection',
          queue: 'config-queue',
          afterCommit: false,
        },
      },
    })

    const queuedInvoicePaid: NotificationDefinition<
      InvoicePaidNotifiable,
      typeof invoicePaid.build
    > = defineNotification({
      type: 'invoice-paid',
      via() {
        return ['email', 'database', 'broadcast'] as const
      },
      queue(_notifiable: InvoicePaidNotifiable, channel: string) {
        if (channel === 'broadcast') {
          return {
            connection: 'notification-connection',
            queue: 'notification-queue',
          }
        }

        return true
      },
      delay(_notifiable: InvoicePaidNotifiable, channel: string) {
        if (channel === 'database') {
          return 10
        }

        if (channel === 'broadcast') {
          return 20
        }

        return undefined
      },
      build: invoicePaid.build,
    })

    const result = await notify({
      id: 'user-1',
      type: 'users',
      email: 'ava@example.com',
      routeNotificationForBroadcast: () => ['private-users.user-1'],
    }, queuedInvoicePaid)
      .onQueue('fluent-queue')
      .delay(15)
      .delayFor('email', 60)

    expect(result.channels).toEqual([
      { channel: 'email', targetIndex: 0, queued: true, success: true },
      { channel: 'database', targetIndex: 0, queued: true, success: true },
      { channel: 'broadcast', targetIndex: 0, queued: true, success: true },
    ])
    expect(queue.dispatches).toEqual([
      expect.objectContaining({
        jobName: notificationsRuntimeInternals.HOLO_NOTIFICATIONS_DELIVER_JOB,
        connection: 'config-connection',
        queue: 'fluent-queue',
        delay: 60,
      }),
      expect.objectContaining({
        jobName: notificationsRuntimeInternals.HOLO_NOTIFICATIONS_DELIVER_JOB,
        connection: 'config-connection',
        queue: 'fluent-queue',
        delay: 15,
      }),
      expect.objectContaining({
        jobName: notificationsRuntimeInternals.HOLO_NOTIFICATIONS_DELIVER_JOB,
        connection: 'notification-connection',
        queue: 'fluent-queue',
        delay: 15,
      }),
    ])
    expect(mailer.send).toHaveBeenCalledTimes(1)
    expect(store.create).toHaveBeenCalledTimes(1)
    expect(broadcaster.send).toHaveBeenCalledTimes(1)
  })

  it('throws a clear error when queue-backed delivery is requested without @holo-js/queue', async () => {
    notificationsRuntimeInternals.setQueueModuleLoader(async () => {
      const error = new Error('missing queue module') as Error & { code?: string }
      error.code = 'ERR_MODULE_NOT_FOUND'
      throw error
    })

    const result = await notify({
      email: 'ava@example.com',
    }, {
      via() {
        return ['email'] as const
      },
      build: {
        email() {
          return {
            subject: 'Queued email',
          }
        },
      },
    }).onQueue('notifications')

    expect(result.channels).toHaveLength(1)
    expect(result.channels[0]).toMatchObject({
      channel: 'email',
      targetIndex: 0,
      queued: false,
      success: false,
      error: expect.any(Error),
    })
    expect((result.channels[0] as { error: Error }).error.message).toContain(
      'Queued or delayed notifications require @holo-js/queue to be installed',
    )
  })

  it('defers notification delivery until commit when afterCommit runs inside a transaction', async () => {
    const mailer = {
      send: vi.fn(async () => {}),
    }
    const afterCommitCallbacks: Array<() => Promise<void>> = []

    configureNotificationsRuntime({
      mailer,
    })
    notificationsRuntimeInternals.setDbModuleLoader(async () => ({
      connectionAsyncContext: {
        getActive() {
          return {
            connection: {
              getScope() {
                return { kind: 'transaction' }
              },
              afterCommit(callback: () => Promise<void>) {
                afterCommitCallbacks.push(callback)
              },
            },
          }
        },
      },
    }))

    const result = await notify({
      email: 'ava@example.com',
    }, {
      via() {
        return ['email'] as const
      },
      build: {
        email() {
          return {
            subject: 'Verify email',
          }
        },
      },
      queue: {
        afterCommit: true,
      },
    })

    expect(result).toEqual({
      totalTargets: 1,
      channels: [
        {
          channel: 'email',
          targetIndex: 0,
          queued: true,
          deferred: true,
          success: true,
        },
      ],
      deferred: true,
    })
    expect(mailer.send).not.toHaveBeenCalled()
    expect(afterCommitCallbacks).toHaveLength(1)

    await afterCommitCallbacks[0]!()

    expect(mailer.send).toHaveBeenCalledTimes(1)
  })

  it('falls back to immediate delivery when afterCommit is requested without an active transaction', async () => {
    const mailer = {
      send: vi.fn(async () => {}),
    }

    configureNotificationsRuntime({
      mailer,
    })
    notificationsRuntimeInternals.setDbModuleLoader(async () => ({
      connectionAsyncContext: {
        getActive() {
          return {
            connection: {
              getScope() {
                return { kind: 'root' }
              },
              afterCommit() {
                throw new Error('should not be called')
              },
            },
          }
        },
      },
    }))

    const result = await notify({
      email: 'ava@example.com',
    }, {
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
    }).afterCommit()

    expect(result).toEqual({
      totalTargets: 1,
      channels: [
        {
          channel: 'email',
          targetIndex: 0,
          queued: false,
          success: true,
        },
      ],
    })
    expect(mailer.send).toHaveBeenCalledTimes(1)
  })

  it('keeps notifyMany() lazy for iterable targets until awaited', async () => {
    const dispatch = vi.fn(async (input) => ({
      totalTargets: input.target.kind === 'many' ? (input.target.value as readonly unknown[]).length : 1,
      channels: [],
    }))
    const iterableState = {
      consumed: false,
    }

    function* recipients() {
      iterableState.consumed = true
      yield { id: 'user-1', email: 'ava@example.com' }
      yield { id: 'user-2', email: 'noor@example.com' }
    }

    configureNotificationsRuntime({ dispatch })

    const pending = notifyMany(recipients(), invoicePaid)

    expect(iterableState.consumed).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()

    await expect(pending).resolves.toEqual({
      totalTargets: 2,
      channels: [],
    })

    expect(iterableState.consumed).toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('manages custom channel registration and lookup', async () => {
    const send = vi.fn(async () => 'ok')

    registerNotificationChannel('slack', {
      send,
    })

    expect(getRegisteredNotificationChannel('  slack  ')).toMatchObject({
      name: 'slack',
    })

    configureNotificationsRuntime({})

    const result = await notifyUsing()
      .channel('slack', { webhook: 'https://hooks.slack.test' } as never)
      .notify({
        via() {
          return ['slack'] as const
        },
        build: {
          slack() {
            return {
              text: 'Deployed',
            }
          },
        },
      } as never)

    expect(result.channels).toEqual([
      {
        channel: 'slack',
        targetIndex: 0,
        queued: false,
        success: true,
        result: 'ok',
      },
    ])
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      route: {
        webhook: 'https://hooks.slack.test',
      },
    }))

    expect(() => registerNotificationChannel('slack', {
      send() {},
    })).toThrow('already registered')
    expect(() => registerNotificationChannel('  ', {
      send() {},
    })).toThrow('non-empty strings')
  })

  it('supports replaceExisting and model-backed custom channel routes', async () => {
    const firstSend = vi.fn(async () => 'first')
    const secondSend = vi.fn(async () => 'second')

    registerNotificationChannel('slack', {
      send: firstSend,
    })
    registerNotificationChannel('slack', {
      validateRoute(route: { webhook: string }) {
        if (!route.webhook.startsWith('https://')) {
          throw new Error('webhook must be https')
        }

        return route
      },
      send: secondSend,
    }, {
      replaceExisting: true,
    })

    configureNotificationsRuntime({})

    const result = await notify({
      id: 'user-1',
      email: 'ava@example.com',
      routeNotificationFor(channel: string) {
        if (channel === 'slack') {
          return {
            webhook: 'https://hooks.slack.test/user-1',
          }
        }

        return undefined
      },
    } as never, {
      via() {
        return ['slack'] as const
      },
      build: {
        slack() {
          return {
            text: 'Model-routed',
          }
        },
      },
    } as never)

    expect(result.channels).toEqual([
      {
        channel: 'slack',
        targetIndex: 0,
        queued: false,
        success: true,
        result: 'second',
      },
    ])
    expect(firstSend).not.toHaveBeenCalled()
    expect(secondSend).toHaveBeenCalledWith(expect.objectContaining({
      route: {
        webhook: 'https://hooks.slack.test/user-1',
      },
      payload: {
        text: 'Model-routed',
      },
    }))
    expect(listRegisteredNotificationChannels()).toEqual([
      expect.objectContaining({
        name: 'slack',
      }),
    ])
  })

  it('validates anonymous custom channel routes before send', async () => {
    const send = vi.fn(async () => 'ok')

    registerNotificationChannel('slack', {
      validateRoute(route: { webhook: string }) {
        if (!route.webhook.startsWith('https://')) {
          throw new Error('webhook must be https')
        }

        return route
      },
      send,
    })

    configureNotificationsRuntime({})

    const invalid = await notifyUsing()
      .channel('slack', { webhook: 'http://hooks.slack.test' } as never)
      .notify({
        via() {
          return ['slack'] as const
        },
        build: {
          slack() {
            return {
              text: 'Deployed',
            }
          },
        },
      } as never)

    expect(invalid.channels).toEqual([
      expect.objectContaining({
        channel: 'slack',
        success: false,
        error: expect.any(Error),
      }),
    ])
    expect((invalid.channels[0] as { error: Error }).error.message).toContain('webhook must be https')

    await notifyUsing()
      .channel('slack', { webhook: 'https://hooks.slack.test' } as never)
      .notify({
        via() {
          return ['slack'] as const
        },
        build: {
          slack() {
            return {
              text: 'Deployed',
            }
          },
        },
      } as never)

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      route: {
        webhook: 'https://hooks.slack.test',
      },
    }))
  })

  it('fans out across mixed built-in and custom channels', async () => {
    const mailer = {
      send: vi.fn(async () => {}),
    }
    const customSend = vi.fn(async () => 'custom-ok')

    registerNotificationChannel('slack', {
      send: customSend,
    })

    configureNotificationsRuntime({
      mailer,
    })

    const result = await notify({
      id: 'user-1',
      email: 'ava@example.com',
      routeNotificationFor(channel: string) {
        if (channel === 'slack') {
          return {
            webhook: 'https://hooks.slack.test/user-1',
          }
        }

        return undefined
      },
    } as never, {
      via() {
        return ['email', 'slack'] as const
      },
      build: {
        email() {
          return {
            subject: 'Hello',
          }
        },
        slack() {
          return {
            text: 'Hello from slack',
          }
        },
      },
    } as never)

    expect(result.channels).toEqual([
      {
        channel: 'email',
        targetIndex: 0,
        queued: false,
        success: true,
      },
      {
        channel: 'slack',
        targetIndex: 0,
        queued: false,
        success: true,
        result: 'custom-ok',
      },
    ])
    expect(mailer.send).toHaveBeenCalledTimes(1)
    expect(customSend).toHaveBeenCalledTimes(1)
  })

  it('exposes runtime internals for route normalization helpers', () => {
    expect(notificationsRuntimeInternals.normalizeEmailRouteFromValue(' ava@example.com ')).toBe('ava@example.com')
    expect(notificationsRuntimeInternals.normalizeDatabaseRouteFromValue({
      id: 'user-1',
      type: ' users ',
    })).toEqual({
      id: 'user-1',
      type: 'users',
    })
    expect(notificationsRuntimeInternals.normalizeDatabaseRouteFromValue({
      id: 42,
      type: 'users',
    })).toEqual({
      id: 42,
      type: 'users',
    })
    expect(notificationsRuntimeInternals.normalizeBroadcastRouteFromValue({
      channels: [' private-users.user-1 '],
    })).toEqual({
      channels: ['private-users.user-1'],
    })
  })

  it('covers runtime helper error paths and alternate route resolution branches', async () => {
    const loaderError = new Error('queue missing') as Error & { code?: string }
    loaderError.code = 'ERR_MODULE_NOT_FOUND'
    notificationsRuntimeInternals.setQueueModuleLoader(async () => {
      throw loaderError
    })
    await expect(notificationsRuntimeInternals.loadQueueModule()).rejects.toThrow('@holo-js/queue')

    const customQueueError = new Error('boom')
    notificationsRuntimeInternals.setQueueModuleLoader(async () => {
      throw customQueueError
    })
    await expect(notificationsRuntimeInternals.loadQueueModule()).rejects.toBe(customQueueError)

    const dbMissing = new Error('db missing') as Error & { code?: string }
    dbMissing.code = 'ERR_MODULE_NOT_FOUND'
    notificationsRuntimeInternals.setDbModuleLoader(async () => {
      throw dbMissing
    })
    await expect(notificationsRuntimeInternals.loadDbModule()).resolves.toBeNull()

    const dbFailure = new Error('db failure')
    notificationsRuntimeInternals.setDbModuleLoader(async () => {
      throw dbFailure
    })
    await expect(notificationsRuntimeInternals.loadDbModule()).rejects.toBe(dbFailure)
    notificationsRuntimeInternals.setDbModuleLoader(undefined)

    expect(() => notificationsRuntimeInternals.normalizeOptionalString('   ', 'label')).toThrow('non-empty string')
    expect(() => notificationsRuntimeInternals.normalizeDelayValue(-1, 'delay')).toThrow('greater than or equal to 0')
    expect(() => notificationsRuntimeInternals.normalizeDelayValue(new Date('invalid'), 'delay')).toThrow('valid Date instances')
    expect(notificationsRuntimeInternals.isObject({ ok: true })).toBe(true)
    expect(notificationsRuntimeInternals.isObject([])).toBe(false)
    expect(notificationsRuntimeInternals.isAnonymousTarget({ anonymous: true, routes: {} })).toBe(true)
    expect(notificationsRuntimeInternals.isAnonymousTarget({ anonymous: false, routes: {} })).toBe(false)

    expect(() => notificationsRuntimeInternals.normalizeEmailRouteFromValue('   ')).toThrow('Email routes must be non-empty strings')
    expect(() => notificationsRuntimeInternals.normalizeEmailRouteFromValue({ name: 'Ava' })).toThrow('must be a string or an object with a non-empty email')
    expect(notificationsRuntimeInternals.resolveEmailRouteFromNotifiable({
      email: 'ava@example.com',
    })).toEqual({
      email: 'ava@example.com',
    })
    expect(notificationsRuntimeInternals.resolveEmailRouteFromNotifiable({
      email: 'ava@example.com',
      name: 'Ava',
    })).toEqual({
      email: 'ava@example.com',
      name: 'Ava',
    })
    expect(() => notificationsRuntimeInternals.resolveEmailRouteFromNotifiable({
      email: '   ',
    })).toThrow('require a notifiable with a non-empty email')

    class Recipient {
      constructor(readonly id: string) {}
    }
    expect(notificationsRuntimeInternals.resolveDatabaseRouteFromNotifiable(new Recipient('user-1'))).toEqual({
      id: 'user-1',
      type: 'Recipient',
    })
    const nullPrototypeRecipient = Object.create(null) as { id: string, type?: string }
    nullPrototypeRecipient.id = 'user-2'
    expect(() => notificationsRuntimeInternals.resolveDatabaseRouteFromNotifiable({ type: 'users' })).toThrow('require a notifiable with a string or numeric id')
    expect(() => notificationsRuntimeInternals.resolveDatabaseRouteFromNotifiable(nullPrototypeRecipient)).toThrow(
      'require a notifiable.type or a non-plain-object constructor name',
    )
    expect(() => notificationsRuntimeInternals.resolveDatabaseRouteFromNotifiable({ id: 'user-1' })).toThrow('require a notifiable.type or a non-plain-object constructor name')

    expect(notificationsRuntimeInternals.normalizeBroadcastRouteFromValue(' private-users.user-1 ')).toBe('private-users.user-1')
    expect(() => notificationsRuntimeInternals.normalizeBroadcastRouteFromValue('   ')).toThrow('must be non-empty strings')
    expect(notificationsRuntimeInternals.normalizeBroadcastRouteFromValue([' one ', 'two'])).toEqual(['one', 'two'])
    expect(() => notificationsRuntimeInternals.normalizeBroadcastRouteFromValue([])).toThrow('must include at least one channel')
    expect(() => notificationsRuntimeInternals.normalizeBroadcastRouteFromValue(['', 'two'])).toThrow('must be a non-empty string')
    expect(() => notificationsRuntimeInternals.normalizeBroadcastRouteFromValue({})).toThrow('must be a string, string array, or object with channels')
    expect(notificationsRuntimeInternals.resolveBroadcastRouteFromNotifiable({
      routeNotificationForBroadcast() {
        return 'private-users.user-1'
      },
    })).toBe('private-users.user-1')
    expect(notificationsRuntimeInternals.resolveBroadcastRouteFromNotifiable({
      broadcastChannels() {
        return ['private-users.user-2']
      },
    })).toEqual(['private-users.user-2'])
    expect(notificationsRuntimeInternals.resolveBroadcastRouteFromNotifiable({
      broadcastChannels: ['private-users.user-3'],
    })).toEqual(['private-users.user-3'])
    expect(() => notificationsRuntimeInternals.resolveBroadcastRouteFromNotifiable({})).toThrow(
      'require an anonymous route or a routeNotificationForBroadcast() method',
    )
    expect(() => notificationsRuntimeInternals.resolveBroadcastRouteFromNotifiable('broken')).toThrow('require an anonymous route or a routeNotificationForBroadcast() method')

    const record = notificationsRuntimeInternals.normalizeNotificationRecord(
      { id: 'user-1', type: 'users' },
      { data: { ok: true } },
      'invoice-paid',
    )
    expect(record).toMatchObject({
      type: 'invoice-paid',
      notifiableType: 'users',
      notifiableId: 'user-1',
      data: {
        ok: true,
      },
      readAt: null,
    })
    expect(record.id).toBeTypeOf('string')
    expect(record.createdAt).toBeInstanceOf(Date)
    expect(record.updatedAt).toBeInstanceOf(Date)
    expect(notificationsRuntimeInternals.normalizeNotificationRecordIds([' a ', 'b', 'a'])).toEqual(['a', 'b'])
    expect(() => notificationsRuntimeInternals.normalizeNotificationRecordIds(['', 'b'])).toThrow('must be a non-empty string')
  })

  it('covers dispatch helper branches, thenable rejection helpers, and runtime facade access', async () => {
    configureNotificationsRuntime({})

    expect(notificationsRuntimeInternals.getDispatchHandler()).toBe(notificationsRuntimeInternals.dispatchNotifications)
    expect(notificationsRuntimeInternals.getRuntimeBindings()).toEqual({})
    expect(getNotificationsRuntimeBindings()).toEqual({})

    const runtime = getNotificationsRuntime()
    expect(runtime.notify).toBe(notify)
    expect(runtime.notifyMany).toBe(notifyMany)
    expect(runtime.notifyUsing).toBe(notifyUsing)
    expect(runtime.listNotifications).toBe(listNotifications)
    expect(runtime.unreadNotifications).toBe(unreadNotifications)
    expect(runtime.markNotificationsAsRead).toBe(markNotificationsAsRead)
    expect(runtime.markNotificationsAsUnread).toBe(markNotificationsAsUnread)
    expect(runtime.deleteNotifications).toBe(deleteNotifications)

    const send = vi.fn(async () => 'ok')
    registerNotificationChannel('slack', { send })

    expect(() => registerNotificationChannel('slack-invalid', {} as never)).toThrow('must define send()')
    expect(notificationsRuntimeInternals.getNotificationChannel('missing')).toBeUndefined()

    const customDispatchError = new Error('dispatch failed')
    configureNotificationsRuntime({
      dispatch: vi.fn(async () => {
        throw customDispatchError
      }),
    })

    const rejected = notify({ id: 'user-1', email: 'ava@example.com' }, invoicePaid)
    await expect(rejected.catch(error => error)).resolves.toBe(customDispatchError)
    await expect(rejected.finally(() => undefined)).rejects.toBe(customDispatchError)

    configureNotificationsRuntime({
      dispatch() {
        throw new Error('sync dispatch failed')
      },
    })

    const syncRejected = notify({ id: 'user-1', email: 'ava@example.com' }, invoicePaid)
    await expect(syncRejected).rejects.toThrow('sync dispatch failed')

    configureNotificationsRuntime({
      mailer: {
        send: vi.fn(async () => {}),
      },
    })

    const pending = new notificationsRuntimeInternals.PendingDispatch({
      kind: 'anonymous',
      value: {
        anonymous: true,
        routes: {
          email: 'ava@example.com',
        },
      },
    }, {
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
    })
    await expect(pending).resolves.toMatchObject({
      totalTargets: 1,
    })

    expect(notificationsRuntimeInternals.createNotificationContext(true)).toEqual({
      anonymous: true,
    })
    expect(notificationsRuntimeInternals.createBuildContext('email', false)).toEqual({
      channel: 'email',
      anonymous: false,
    })
  })

  it('covers internal dispatch planning, queue job, and route helper branches', async () => {
    try {
      const queueModule = createQueueModuleStub().module
      notificationsRuntimeInternals.setQueueModuleLoader(async () => queueModule)
      await expect(notificationsRuntimeInternals.loadQueueModule()).resolves.toBe(queueModule)

      const queueMissing = new Error('queue missing') as Error & { code?: string }
      queueMissing.code = 'ERR_MODULE_NOT_FOUND'
      notificationsRuntimeInternals.setQueueModuleLoader(async () => {
        throw queueMissing
      })
      await expect(notificationsRuntimeInternals.loadQueueModule()).rejects.toThrow('@holo-js/queue')

      const queueFailure = new Error('queue failure')
      notificationsRuntimeInternals.setQueueModuleLoader(async () => {
        throw queueFailure
      })
      await expect(notificationsRuntimeInternals.loadQueueModule()).rejects.toBe(queueFailure)
    } finally {
      notificationsRuntimeInternals.setQueueModuleLoader(undefined)
    }

    expect(notificationsRuntimeInternals.normalizeDelayValue(new Date('2026-01-01T00:00:00.000Z'), 'delay'))
      .toEqual(new Date('2026-01-01T00:00:00.000Z'))

    const anonymousTarget = notificationsRuntimeInternals.resolveTargets({
      kind: 'anonymous',
      value: {
        anonymous: true,
        routes: {
          email: 'ava@example.com',
        },
      },
    })
    expect(anonymousTarget).toEqual([
      {
        index: 0,
        anonymous: true,
        notifiable: {
          anonymous: true,
          routes: {
            email: 'ava@example.com',
          },
        },
        routes: {
          email: 'ava@example.com',
        },
      },
    ])
    expect(() => notificationsRuntimeInternals.resolveTargets({
      kind: 'anonymous',
      value: {},
    })).toThrow('must be created through notifyUsing()')
    expect(() => notificationsRuntimeInternals.resolveTargets({
      kind: 'many',
      value: {} as never,
    })).toThrow('requires an array target')

    expect(() => notificationsRuntimeInternals.resolveChannels({
      via() {
        return 'email' as never
      },
      build: {
        email() {
          return {
            subject: 'Hello',
          }
        },
      },
    }, {
      index: 0,
      anonymous: false,
      notifiable: { email: 'ava@example.com' },
    })).toThrow('must return an array of channel names')
    expect(() => notificationsRuntimeInternals.resolveChannels({
      via() {
        return [123] as never
      },
      build: {
        email() {
          return {
            subject: 'Hello',
          }
        },
      },
    }, {
      index: 0,
      anonymous: false,
      notifiable: { email: 'ava@example.com' },
    })).toThrow('must be a string')

    expect(notificationsRuntimeInternals.resolveNotificationQueueOptions({
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
      queue: {
        queue: 'notifications',
      },
    }, {
      index: 0,
      anonymous: false,
      notifiable: {},
    }, 'email')).toEqual({
      queue: 'notifications',
    })

    expect(notificationsRuntimeInternals.resolveNotificationDelay({
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
      delay: 15,
    }, {
      index: 0,
      anonymous: false,
      notifiable: {},
    }, 'email')).toBe(15)
    const delayedAt = new Date('2026-01-01T00:00:00.000Z')
    expect(notificationsRuntimeInternals.resolveNotificationDelay({
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
      delay: delayedAt,
    }, {
      index: 0,
      anonymous: false,
      notifiable: {},
    }, 'email')).toBe(delayedAt)
    expect(notificationsRuntimeInternals.resolveNotificationDelay({
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
      delay: {
        email: 45,
      },
    }, {
      index: 0,
      anonymous: false,
      notifiable: {},
    }, 'email')).toBe(45)

    expect(() => notificationsRuntimeInternals.resolveRoute('email', {
      index: 0,
      anonymous: true,
      notifiable: {},
      routes: {},
    })).toThrow('must define a route for channel "email"')
    expect(() => notificationsRuntimeInternals.resolveRoute('email', {
      index: 0,
      anonymous: true,
      notifiable: {},
    } as never)).toThrow('must define a route for channel "email"')
    expect(() => notificationsRuntimeInternals.resolveRoute('missing', {
      index: 0,
      anonymous: false,
      notifiable: {},
    })).toThrow('is not registered')

    registerNotificationChannel('validated', {
      validateRoute(route: { id: string }) {
        return {
          id: route.id.trim(),
        }
      },
      send() {
        return undefined
      },
    })
    expect(notificationsRuntimeInternals.resolveRoute('validated', {
      index: 0,
      anonymous: false,
      notifiable: {
        routeNotificationFor() {
          return {
            id: ' custom ',
          }
        },
      },
    })).toEqual({
      id: 'custom',
    })
    expect(notificationsRuntimeInternals.resolveRoute('validated', {
      index: 0,
      anonymous: false,
      notifiable: {},
    })).toBeUndefined()

    registerNotificationChannel('plain', {
      send() {
        return undefined
      },
    })
    expect(notificationsRuntimeInternals.resolveRoute('plain', {
      index: 0,
      anonymous: false,
      notifiable: {
        routeNotificationFor() {
          return 'plain-route'
        },
      },
    })).toBe('plain-route')
    expect(notificationsRuntimeInternals.resolveRoute('plain', {
      index: 0,
      anonymous: false,
      notifiable: {},
    })).toBeUndefined()

    configureNotificationsRuntime({})
    await expect(notificationsRuntimeInternals.deliverResolvedNotificationChannel({
      channel: 'email',
      anonymous: false,
      notifiable: {},
      route: 'ava@example.com',
      payload: {
        subject: 'Hello',
      },
      targetIndex: 0,
    })).rejects.toThrow('require a configured mailer runtime')
    await expect(notificationsRuntimeInternals.deliverResolvedNotificationChannel({
      channel: 'database',
      anonymous: false,
      notifiable: {},
      payload: {
        data: {},
      },
      targetIndex: 0,
    })).rejects.toThrow('require a resolved route')
    await expect(notificationsRuntimeInternals.deliverResolvedNotificationChannel({
      channel: 'database',
      anonymous: false,
      notifiable: {},
      route: {
        id: 'user-1',
        type: 'users',
      },
      payload: {
        data: {},
      },
      targetIndex: 0,
    })).rejects.toThrow('require a configured notification store runtime')
    await expect(notificationsRuntimeInternals.deliverResolvedNotificationChannel({
      channel: 'broadcast',
      anonymous: false,
      notifiable: {},
      route: ['private-users.user-1'],
      payload: {
        data: {},
      },
      targetIndex: 0,
    })).rejects.toThrow('require a configured broadcaster runtime')
    await expect(notificationsRuntimeInternals.deliverResolvedNotificationChannel({
      channel: 'missing',
      anonymous: false,
      notifiable: {},
      payload: {},
      targetIndex: 0,
    })).rejects.toThrow('is not registered')

    const customSend = vi.fn(async () => 'ok')
    registerNotificationChannel('validated-send', {
      validateRoute(route: { id: string }) {
        return {
          id: route.id.trim(),
        }
      },
      send: customSend,
    })
    await expect(notificationsRuntimeInternals.deliverResolvedNotificationChannel({
      channel: 'validated-send',
      anonymous: false,
      notifiable: {},
      route: {
        id: ' route ',
      },
      payload: {
        ok: true,
      },
      targetIndex: 0,
    })).resolves.toBe('ok')
    expect(customSend).toHaveBeenCalledWith(expect.objectContaining({
      route: {
        id: 'route',
      },
    }))

    const plainSend = vi.fn(async () => 'plain')
    registerNotificationChannel('plain-send', {
      send: plainSend,
    })
    await expect(notificationsRuntimeInternals.deliverResolvedNotificationChannel({
      channel: 'plain-send',
      anonymous: false,
      notifiable: {},
      payload: {
        ok: true,
      },
      targetIndex: 0,
    })).resolves.toBe('plain')
    expect(plainSend).toHaveBeenCalledWith(expect.objectContaining({
      payload: {
        ok: true,
      },
    }))

    expect(notificationsRuntimeInternals.createQueuedDeliveryPayload({
      channel: 'plain-send',
      anonymous: false,
      notifiable: {
        id: 'user-1',
      },
      payload: {
        ok: true,
      },
      targetIndex: 0,
    })).toEqual({
      channel: 'plain-send',
      anonymous: false,
      notifiable: {
        id: 'user-1',
      },
      payload: {
        ok: true,
      },
      targetIndex: 0,
    })

    const queue = createQueueModuleStub()
    await notificationsRuntimeInternals.ensureNotificationsQueueJobRegistered(queue.module)
    await notificationsRuntimeInternals.ensureNotificationsQueueJobRegistered(queue.module)
    expect(queue.jobs.size).toBe(1)

    expect(notificationsRuntimeInternals.resolveChannelDispatchPlan({
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
    }, {
      index: 0,
      anonymous: false,
      notifiable: {},
    }, 'email', {})).toEqual({
      channel: 'email',
      queued: false,
      connection: undefined,
      queue: undefined,
      delay: undefined,
      afterCommit: false,
    })

    expect(notificationsRuntimeInternals.resolveTargets({
      kind: 'many',
      value: [{ id: 'user-1' }, { id: 'user-2' }],
    })).toEqual([
      {
        index: 0,
        anonymous: false,
        notifiable: { id: 'user-1' },
      },
      {
        index: 1,
        anonymous: false,
        notifiable: { id: 'user-2' },
      },
    ])

    expect(notificationsRuntimeInternals.resolveNotificationDelay({
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
      delay(_notifiable, _channel, context) {
        return context.anonymous ? 50 : 25
      },
    }, {
      index: 0,
      anonymous: true,
      notifiable: {},
    }, 'email')).toBe(50)
    expect(notificationsRuntimeInternals.resolveNotificationDelay({
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
    }, {
      index: 0,
      anonymous: false,
      notifiable: {},
    }, 'email')).toBeUndefined()

    notificationsRuntimeInternals.setDbModuleLoader(async () => ({
      connectionAsyncContext: {
        getActive() {
          return undefined
        },
      },
    }))
    await expect(notificationsRuntimeInternals.deferDispatchUntilCommit({
      target: {
        kind: 'notifiable',
        value: { email: 'ava@example.com' },
      },
      notification: {
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
      },
      options: {},
    }, [{
      index: 0,
      anonymous: false,
      notifiable: { email: 'ava@example.com' },
    }], {
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
    })).resolves.toBeNull()

    const finallyDispatch = notify({ id: 'user-1', email: 'ava@example.com' }, invoicePaid)
    await expect(finallyDispatch.finally()).resolves.toMatchObject({
      totalTargets: 1,
    })
  })
})
