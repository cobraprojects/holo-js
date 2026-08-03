import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureNotificationsRuntime,
  defineNotification,
  getNotificationsRuntimeBindings,
  getNotificationsRuntime,
  getRegisteredNotificationChannel,
  listRegisteredNotificationChannels,
  loadNotificationPluginChannels,
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
  type NotificationRecord,
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
    readonly plugin: NotificationChannel<{ readonly token: string }, { readonly text: string }, {
      readonly channel: string
      readonly payload: { readonly text: string }
      readonly route: { readonly token: string }
    }>
    readonly slack: NotificationChannel<{ readonly webhook: string }, { readonly text: string }, void>
  }
}

function asRuntimeNotification<TNotifiable, TBuild extends NotificationBuildFactories<TNotifiable>>(
  notification: NotificationDefinition<TNotifiable, TBuild>,
): NotificationDefinition<unknown, NotificationBuildFactories<unknown>> {
  return notification as unknown as NotificationDefinition<unknown, NotificationBuildFactories<unknown>>
}

async function writeNotificationPluginProject(
  projectRoot: string,
  packageName: string,
  channelName: string,
  label: string,
): Promise<void> {
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
    name: `${label}-notifications-plugin-fixture`,
    private: true,
  }, null, 2))
  await mkdir(join(projectRoot, 'config'), { recursive: true })
  await writeFile(join(projectRoot, 'config/app.mjs'), `
export default {
  plugins: ['${packageName}'],
}
`)
  const pluginRoot = join(projectRoot, 'node_modules', packageName)
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
    name: packageName,
    type: 'module',
    holo: {
      plugin: './plugin.mjs',
    },
  }, null, 2))
  await writeFile(join(pluginRoot, 'plugin.mjs'), `
export default {
  id: '${label}-notifications-plugin',
  contributes: {
    notifications: {
      channels: {
        ${channelName}: {
          runtime: './channel.mjs',
        },
      },
    },
  },
}
`)
  await writeFile(join(pluginRoot, 'channel.mjs'), `
export default {
  async send() {
    return {
      project: '${label}',
    }
  },
}
`)
}

const invoicePaidDefinition: NotificationDefinition<
  InvoicePaidNotifiable,
  NotificationBuildFactories<InvoicePaidNotifiable>
> = {
  type: 'invoice-paid',
  via() {
    return ['email', 'database', 'broadcast']
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

  it('deduplicates database delivery by a bounded server-side key', async () => {
    const create = vi.fn(async () => {})
    configureNotificationsRuntime({
      store: {
        create,
        delete: vi.fn(),
        list: vi.fn(),
        markAsRead: vi.fn(),
        markAsUnread: vi.fn(),
        unread: vi.fn(),
      },
    })
    const definition = defineNotification({
      type: 'transfer-completed',
      via(_user: { readonly id: string, readonly type: string }) {
        return ['database']
      },
      build: {
        database() {
          return { data: { status: 'completed' } }
        },
      },
    })

    const pending = notify({ id: 'actor-1', type: 'admins' }, definition)
      .deduplicate('transfer-outbox-1')

    await expect(pending.dispatch()).resolves.toMatchObject({
      channels: [{ channel: 'database', success: true }],
    })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      id: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u),
      notifiableId: 'actor-1',
      notifiableType: 'admins',
      type: 'transfer-completed',
    }))
  })

  it('scopes database deduplication identities to each recipient', async () => {
    const create = vi.fn(async (_record: NotificationRecord) => {})
    configureNotificationsRuntime({
      store: {
        create,
        delete: vi.fn(),
        list: vi.fn(),
        markAsRead: vi.fn(),
        markAsUnread: vi.fn(),
        unread: vi.fn(),
      },
    })
    const definition = defineNotification({
      type: 'transfer-completed',
      via(_user: { readonly id: string, readonly type: string }) {
        return ['database']
      },
      build: {
        database() {
          return { data: { status: 'completed' } }
        },
      },
    })

    await notifyMany([
      { id: 'actor-1', type: 'admins' },
      { id: 'actor-2', type: 'admins' },
    ], definition).deduplicate('transfer-outbox-many').dispatch()

    const ids = create.mock.calls.map(([record]) => record.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids)).toHaveLength(2)
  })

  it('rejects unsafe deduplication keys and non-database delivery before sending', async () => {
    const mailer = { send: vi.fn(async () => {}) }
    const create = vi.fn(async () => {})
    configureNotificationsRuntime({
      mailer,
      store: {
        create,
        delete: vi.fn(),
        list: vi.fn(),
        markAsRead: vi.fn(),
        markAsUnread: vi.fn(),
        unread: vi.fn(),
      },
    })

    expect(() => notify({ email: 'ava@example.com' }, invoicePaid).deduplicate('line\nbreak'))
      .toThrow('between 1 and 200 printable ASCII characters')
    await expect(notify({
      email: 'ava@example.com',
      id: 'actor-1',
      type: 'admins',
    }, invoicePaid).deduplicate('transfer-outbox-2').dispatch())
      .rejects.toThrow('every resolved channel to be the built-in database channel')
    expect(mailer.send).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('evaluates notification channels once per target during dispatch', async () => {
    const mailer = {
      send: vi.fn(async () => {}),
    }
    const via = vi.fn(() => ['email'] as const)

    configureNotificationsRuntime({
      mailer,
    })

    await expect(notify({
      email: 'ava@example.com',
    }, defineNotification({
      via,
      build: {
        email() {
          return {
            subject: 'Hello',
          }
        },
      },
    }))).resolves.toMatchObject({
      totalTargets: 1,
      channels: [
        {
          channel: 'email',
          success: true,
        },
      ],
    })

    expect(via).toHaveBeenCalledOnce()
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

  it.each([
    { id: '   ', type: 'users' },
    { id: 'user-1', type: 'x'.repeat(201) },
    { id: 'x'.repeat(201), type: 'users' },
    { id: Number.POSITIVE_INFINITY, type: 'users' },
  ])('rejects invalid anonymous database recipients before persistence', async (route) => {
    const store = {
      create: vi.fn(async () => {}),
      list: vi.fn(),
      unread: vi.fn(),
      markAsRead: vi.fn(),
      markAsUnread: vi.fn(),
      delete: vi.fn(),
    }
    configureNotificationsRuntime({ store })

    const result = await notifyUsing()
      .channel('database', route)
      .notify(asRuntimeNotification(invoicePaid))

    expect(result.channels.find(channel => channel.channel === 'database')).toMatchObject({
      channel: 'database',
      success: false,
      error: expect.any(Error),
    })
    expect(store.create).not.toHaveBeenCalled()
  })

  it('rejects invalid model-backed database recipients before persistence', async () => {
    const store = {
      create: vi.fn(async () => {}),
      list: vi.fn(),
      unread: vi.fn(),
      markAsRead: vi.fn(),
      markAsUnread: vi.fn(),
      delete: vi.fn(),
    }
    configureNotificationsRuntime({ store })

    const result = await notify({
      id: '   ',
      type: 'users',
      email: 'ava@example.com',
    }, invoicePaid)

    expect(result.channels[1]).toMatchObject({
      channel: 'database',
      success: false,
      error: expect.any(Error),
    })
    expect(store.create).not.toHaveBeenCalled()
  })

  it('dispatches registered channels when unrelated plugin channels are broken', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-notifications-broken-plugin-'))
    const previousCwd = process.cwd()
    const send = vi.fn(async () => undefined)

    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'notifications-broken-plugin-fixture',
        private: true,
      }, null, 2))
      await mkdir(join(projectRoot, 'config'), { recursive: true })
      await writeFile(join(projectRoot, 'config/app.mjs'), `
export default {
  plugins: ['holo-plugin-broken-notifications'],
}
`)
      const pluginRoot = join(projectRoot, 'node_modules/holo-plugin-broken-notifications')
      await mkdir(pluginRoot, { recursive: true })
      await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
        name: 'holo-plugin-broken-notifications',
        type: 'module',
        holo: {
          plugin: './plugin.mjs',
        },
      }, null, 2))
      await writeFile(join(pluginRoot, 'plugin.mjs'), `
export default {
  id: 'broken-notifications-plugin',
  contributes: {
    notifications: {
      channels: {
        broken: {
          runtime: './missing.mjs',
        },
      },
    },
  },
}
`)
      await writeFile(join(pluginRoot, 'missing.mjs'), `
export default {}
`)

      configureNotificationsRuntime({
        projectRoot: ` ${projectRoot} `,
        plugins: ['holo-plugin-broken-notifications'],
      } as Parameters<typeof configureNotificationsRuntime>[0] & { readonly projectRoot: string })
      registerNotificationChannel('slack', {
        send,
      }, { replaceExisting: true })

      await expect(notifyUsing()
        .channel('slack', { webhook: 'https://hooks.example.test' })
        .notify(asRuntimeNotification({
          type: 'registered-alert',
          via() {
            return ['slack']
          },
          build: {
            slack() {
              return {
                text: 'Delivered through registered channel.',
              }
            },
          },
        }))).resolves.toMatchObject({
        channels: [
          {
            channel: 'slack',
            success: true,
          },
        ],
      })
      expect(send).toHaveBeenCalledOnce()
      await expect(loadNotificationPluginChannels(projectRoot, ['holo-plugin-broken-notifications'])).rejects.toThrow('must export send()')
      await expect(loadNotificationPluginChannels(projectRoot, ['holo-plugin-broken-notifications'])).rejects.toThrow('must export send()')
    } finally {
      process.chdir(previousCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('dispatches notification channels contributed by active Holo plugins', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-notifications-plugin-'))
    const previousCwd = process.cwd()

    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'notifications-plugin-fixture',
        private: true,
      }, null, 2))
      await mkdir(join(projectRoot, 'config'), { recursive: true })
      await writeFile(join(projectRoot, 'config/app.mjs'), `
export default {
  plugins: ['holo-plugin-notifications'],
}
`)
      const pluginRoot = join(projectRoot, 'node_modules/holo-plugin-notifications')
      await mkdir(pluginRoot, { recursive: true })
      await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
        name: 'holo-plugin-notifications',
        type: 'module',
        holo: {
          plugin: './plugin.mjs',
        },
      }, null, 2))
      await writeFile(join(pluginRoot, 'plugin.mjs'), `
export default {
  id: 'notifications-plugin',
  contributes: {
    notifications: {
      channels: {
        plugin: {
          runtime: './channel.mjs',
        },
      },
    },
  },
}
`)
      await writeFile(join(pluginRoot, 'channel.mjs'), `
export default {
  async send(context) {
    return {
      channel: context.channel,
      payload: context.payload,
      route: context.route,
    }
  },
}
`)

      configureNotificationsRuntime({
        projectRoot: ` ${projectRoot} `,
        plugins: ['holo-plugin-notifications'],
      } as Parameters<typeof configureNotificationsRuntime>[0] & { readonly projectRoot: string })

      const result = await notifyUsing()
        .channel('plugin', { token: 'plugin-route' })
        .notify(asRuntimeNotification({
          type: 'plugin-alert',
          via() {
            return ['plugin']
          },
          build: {
            plugin() {
              return {
                text: 'Delivered through plugin.',
              }
            },
          },
        }))

      expect(result.channels).toEqual([
        expect.objectContaining({
          channel: 'plugin',
          success: true,
          result: {
            channel: 'plugin',
            payload: {
              text: 'Delivered through plugin.',
            },
            route: {
              token: 'plugin-route',
            },
          },
        }),
      ])
      await expect(loadNotificationPluginChannels(projectRoot, ['holo-plugin-notifications'])).resolves.toBeUndefined()
      await expect(loadNotificationPluginChannels(projectRoot, ['holo-plugin-notifications'])).resolves.toBeUndefined()
    } finally {
      process.chdir(previousCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('clears notification plugin channels when the runtime resets', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'holo-notifications-plugin-first-'))
    const secondRoot = await mkdtemp(join(tmpdir(), 'holo-notifications-plugin-second-'))

    try {
      await writeNotificationPluginProject(firstRoot, 'holo-plugin-notifications-first', 'plugin', 'first')
      await writeNotificationPluginProject(secondRoot, 'holo-plugin-notifications-second', 'plugin', 'second')

      configureNotificationsRuntime({
        projectRoot: firstRoot,
        plugins: ['holo-plugin-notifications-first'],
      } as Parameters<typeof configureNotificationsRuntime>[0] & { readonly projectRoot: string })

      const first = await notifyUsing()
        .channel('plugin', { token: 'first-route' })
        .notify(asRuntimeNotification({
          type: 'plugin-alert',
          via() {
            return ['plugin']
          },
          build: {
            plugin() {
              return {
                text: 'Delivered through first plugin.',
              }
            },
          },
        }))

      expect(first.channels[0]?.result).toEqual({
        project: 'first',
      })

      resetNotificationsRuntime()
      configureNotificationsRuntime({
        projectRoot: secondRoot,
        plugins: ['holo-plugin-notifications-second'],
      } as Parameters<typeof configureNotificationsRuntime>[0] & { readonly projectRoot: string })

      const second = await notifyUsing()
        .channel('plugin', { token: 'second-route' })
        .notify(asRuntimeNotification({
          type: 'plugin-alert',
          via() {
            return ['plugin']
          },
          build: {
            plugin() {
              return {
                text: 'Delivered through second plugin.',
              }
            },
          },
        }))

      expect(second.channels[0]?.result).toEqual({
        project: 'second',
      })
    } finally {
      await rm(firstRoot, { recursive: true, force: true })
      await rm(secondRoot, { recursive: true, force: true })
    }
  })

  it('loads plugin channels while delivering queued notifications', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-notifications-queued-plugin-'))
    const previousCwd = process.cwd()

    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'notifications-queued-plugin-fixture',
        private: true,
      }, null, 2))
      await mkdir(join(projectRoot, 'config'), { recursive: true })
      await writeFile(join(projectRoot, 'config/app.mjs'), `
export default {
  plugins: ['holo-plugin-notifications-queued'],
}
`)
      const pluginRoot = join(projectRoot, 'node_modules/holo-plugin-notifications-queued')
      await mkdir(pluginRoot, { recursive: true })
      await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
        name: 'holo-plugin-notifications-queued',
        type: 'module',
        holo: {
          plugin: './plugin.mjs',
        },
      }, null, 2))
      await writeFile(join(pluginRoot, 'plugin.mjs'), `
export default {
  id: 'notifications-queued-plugin',
  contributes: {
    notifications: {
      channels: {
        plugin: {
          runtime: './channel.mjs',
        },
      },
    },
  },
}
`)
      await writeFile(join(pluginRoot, 'channel.mjs'), `
export default {
  async send(context) {
    return {
      channel: context.channel,
      payload: context.payload,
      route: context.route,
    }
  },
}
`)

      configureNotificationsRuntime({
        projectRoot,
        plugins: ['holo-plugin-notifications-queued'],
      } as Parameters<typeof configureNotificationsRuntime>[0] & { readonly projectRoot: string })

      await expect(notificationsRuntimeInternals.runQueuedNotificationDelivery({
        channel: 'plugin',
        anonymous: false,
        notifiable: {
          id: 'user-1',
        },
        route: {
          token: 'queued-route',
        },
        notificationType: 'plugin-alert',
        payload: {
          text: 'Delivered through queued plugin.',
        },
        targetIndex: 0,
      })).resolves.toEqual({
        channel: 'plugin',
        payload: {
          text: 'Delivered through queued plugin.',
        },
        route: {
          token: 'queued-route',
        },
      })
    } finally {
      process.chdir(previousCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('exposes typed database notification read and mutation helpers through the configured store', async () => {
    const listedRecords = [
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
    const unreadRecords = [
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
      list: vi.fn(async () => ({ records: listedRecords, limit: 20, offset: 0, total: 1, unread: 1 })),
      unread: vi.fn(async () => ({ records: unreadRecords, limit: 20, offset: 0, total: 1, unread: 1 })),
      markAsRead: vi.fn(async () => 2),
      markAsUnread: vi.fn(async () => 1),
      delete: vi.fn(async () => 3),
    }

    configureNotificationsRuntime({ store })

    const query = {
      recipient: { id: 'user-1', type: 'users' },
      type: ' invoice-paid ',
      dataMatches: [{ path: ['tenant', 'id'], value: 'tenant-1' }],
    } as const
    const normalizedQuery = {
      recipient: { id: 'user-1', type: 'users' },
      type: 'invoice-paid',
      dataMatches: [{ path: ['tenant', 'id'], value: 'tenant-1' }],
    }
    const pagination = { limit: 20, offset: 0 }

    await expect(listNotifications(query, pagination)).resolves.toEqual({ records: listedRecords, limit: 20, offset: 0, total: 1, unread: 1 })
    await expect(unreadNotifications(query, pagination)).resolves.toEqual({ records: unreadRecords, limit: 20, offset: 0, total: 1, unread: 1 })
    await expect(markNotificationsAsRead(query, [' notif-1 ', 'notif-2', 'notif-1'])).resolves.toBe(2)
    await expect(markNotificationsAsUnread(query, ['notif-3'])).resolves.toBe(1)
    await expect(deleteNotifications(query, ['notif-4', 'notif-5'])).resolves.toBe(3)

    expect(store.list).toHaveBeenCalledWith(normalizedQuery, pagination)
    expect(store.unread).toHaveBeenCalledWith(normalizedQuery, pagination)
    expect(store.markAsRead).toHaveBeenCalledWith(normalizedQuery, ['notif-1', 'notif-2'])
    expect(store.markAsUnread).toHaveBeenCalledWith(normalizedQuery, ['notif-3'])
    expect(store.delete).toHaveBeenCalledWith(normalizedQuery, ['notif-4', 'notif-5'])
  })

  it('rejects unsafe notification query paths, scalar matches, pagination, and mutation batches', async () => {
    const store = {
      create: vi.fn(async () => {}),
      list: vi.fn(),
      unread: vi.fn(),
      markAsRead: vi.fn(),
      markAsUnread: vi.fn(),
      delete: vi.fn(),
    }
    configureNotificationsRuntime({ store })
    const recipient = { id: 'user-1', type: 'users' }

    await expect(listNotifications({ recipient, dataMatches: [{ path: ['__proto__'], value: 'unsafe' }] }, { limit: 20, offset: 0 })).rejects.toThrow('path segment')
    await expect(listNotifications({ recipient, dataMatches: [{ path: ['tenant'], value: { id: 1 } as never }] }, { limit: 20, offset: 0 })).rejects.toThrow('JSON scalars')
    await expect(listNotifications({ recipient, type: 42 } as never, { limit: 20, offset: 0 })).rejects.toThrow('must be strings')
    await expect(listNotifications({ recipient: { id: ' ', type: 'users' } }, { limit: 20, offset: 0 })).rejects.toThrow('route ids')
    await expect(listNotifications({ recipient: { id: 'user-1', type: 'x'.repeat(201) } }, { limit: 20, offset: 0 })).rejects.toThrow('route types')
    await expect(listNotifications({ recipient }, { limit: 101, offset: 0 })).rejects.toThrow('limits')
    await expect(listNotifications({ recipient }, { limit: 20, offset: -1 })).rejects.toThrow('offsets')
    await expect(markNotificationsAsRead({ recipient }, Array.from({ length: 101 }, (_, index) => `notification-${index}`))).rejects.toThrow('at most 100')
    expect(store.list).not.toHaveBeenCalled()
    expect(store.markAsRead).not.toHaveBeenCalled()
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
          return ['email', 'database']
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
      .toContain('Database route types must be between 1 and 200 characters')
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
    } as never, {
      via() {
        return ['email', 'database']
      },
      build: {
        email() {
          return {
            subject: 'Hello',
          }
        },
      },
    } as never)

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
        return ['sms']
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
        return ['email', 'database', 'broadcast']
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

  it('does not queue immediate notifications from queue config defaults alone', async () => {
    const mailer = {
      send: vi.fn(async () => {}),
    }
    const loadQueue = vi.fn(async () => createQueueModuleStub().module)

    notificationsRuntimeInternals.setQueueModuleLoader(loadQueue)
    configureNotificationsRuntime({
      mailer,
      config: {
        table: 'notifications',
        queue: {
          connection: 'config-connection',
          queue: 'config-queue',
          afterCommit: true,
        },
      },
    })

    const result = await notify({
      id: 'user-1',
      email: 'ava@example.com',
    }, defineNotification({
      via() {
        return ['email']
      },
      build: {
        email() {
          return {
            subject: 'Immediate',
          }
        },
      },
    }))

    expect(result.channels).toEqual([
      {
        channel: 'email',
        targetIndex: 0,
        queued: false,
        success: true,
      },
    ])
    expect(mailer.send).toHaveBeenCalledTimes(1)
    expect(loadQueue).not.toHaveBeenCalled()
  })

  it('throws a clear error when queue-backed delivery is requested without @holo-js/queue', async () => {
    notificationsRuntimeInternals.setQueueModuleLoader(async () => {
      const error = new Error('missing queue module') as Error & { code?: string }
      error.code = 'ERR_MODULE_NOT_FOUND'
      throw error
    })

    const result = await notify({
      email: 'ava@example.com',
    }, defineNotification({
      via() {
        return ['email']
      },
      build: {
        email() {
          return {
            subject: 'Queued email',
          }
        },
      },
    })).onQueue('notifications')

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

  it('validates queue resolver options before loading the queue integration', async () => {
    const loadQueueModule = vi.fn(async () => createQueueModuleStub().module)

    notificationsRuntimeInternals.setQueueModuleLoader(loadQueueModule)

    const blankQueue = await notify({
      email: 'ava@example.com',
    }, defineNotification({
      via() {
        return ['email']
      },
      queue() {
        return {
          queue: '   ',
        }
      },
      build: {
        email() {
          return {
            subject: 'Queued email',
          }
        },
      },
    }))

    expect(blankQueue.channels).toEqual([
      expect.objectContaining({
        channel: 'email',
        targetIndex: 0,
        queued: false,
        success: false,
        error: expect.any(Error),
      }),
    ])
    expect((blankQueue.channels[0] as { error: Error }).error.message).toContain(
      'Notification queue name must be a non-empty string',
    )
    expect(loadQueueModule).not.toHaveBeenCalled()

    const negativeQueueDelay = await notify({
      email: 'ava@example.com',
    }, defineNotification({
      via() {
        return ['email']
      },
      queue() {
        return {
          delay: -1,
        }
      },
      build: {
        email() {
          return {
            subject: 'Queued email',
          }
        },
      },
    }))

    expect(negativeQueueDelay.channels).toEqual([
      expect.objectContaining({
        channel: 'email',
        targetIndex: 0,
        queued: false,
        success: false,
        error: expect.any(Error),
      }),
    ])
    expect((negativeQueueDelay.channels[0] as { error: Error }).error.message).toContain(
      'Notification queue delay must be a finite number greater than or equal to 0',
    )
    expect(loadQueueModule).not.toHaveBeenCalled()
  })

  it('validates delay resolver values before loading the queue integration', async () => {
    const loadQueueModule = vi.fn(async () => createQueueModuleStub().module)

    notificationsRuntimeInternals.setQueueModuleLoader(loadQueueModule)

    const negativeDelay = await notify({
      email: 'ava@example.com',
    }, defineNotification({
      via() {
        return ['email']
      },
      delay() {
        return -1
      },
      build: {
        email() {
          return {
            subject: 'Delayed email',
          }
        },
      },
    }))

    expect(negativeDelay.channels).toEqual([
      expect.objectContaining({
        channel: 'email',
        targetIndex: 0,
        queued: false,
        success: false,
        error: expect.any(Error),
      }),
    ])
    expect((negativeDelay.channels[0] as { error: Error }).error.message).toContain(
      'Notification delay must be a finite number greater than or equal to 0',
    )
    expect(loadQueueModule).not.toHaveBeenCalled()

    const invalidDateDelay = await notify({
      email: 'ava@example.com',
    }, defineNotification({
      via() {
        return ['email']
      },
      delay() {
        return new Date(Number.NaN)
      },
      build: {
        email() {
          return {
            subject: 'Delayed email',
          }
        },
      },
    }))

    expect(invalidDateDelay.channels).toEqual([
      expect.objectContaining({
        channel: 'email',
        targetIndex: 0,
        queued: false,
        success: false,
        error: expect.any(Error),
      }),
    ])
    expect((invalidDateDelay.channels[0] as { error: Error }).error.message).toContain(
      'Notification delay dates must be valid Date instances',
    )
    expect(loadQueueModule).not.toHaveBeenCalled()
  })

  it('defers notification delivery until commit when afterCommit runs inside a transaction', async () => {
    const mailer = {
      send: vi.fn(async () => {}),
    }
    const afterCommitCallbacks: Array<() => Promise<void>> = []

    configureNotificationsRuntime({
      deferAfterCommit(callback) {
        afterCommitCallbacks.push(callback)
        return true
      },
      mailer,
    })

    const result = await notify({
      email: 'ava@example.com',
    }, defineNotification({
      via() {
        return ['email']
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
    }))

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
      deferAfterCommit() {
        return false
      },
      mailer,
    })

    const result = await notify({
      email: 'ava@example.com',
    }, defineNotification({
      via() {
        return ['email']
      },
      build: {
        email() {
          return {
            subject: 'Hello',
          }
        },
      },
    })).afterCommit()

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
          return ['slack']
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
        return ['slack']
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

  it('lets registered channels replace built-in dispatch channels', async () => {
    const send = vi.fn(async () => 'custom-email')

    registerNotificationChannel('email', {
      send,
    }, {
      replaceExisting: true,
    })

    configureNotificationsRuntime({})

    const result = await notifyUsing()
      .channel('email', { address: 'ava@example.com' } as never)
      .notify({
        via() {
          return ['email']
        },
        build: {
          email() {
            return {
              subject: 'Custom email',
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
        result: 'custom-email',
      },
    ])
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      route: {
        address: 'ava@example.com',
      },
      payload: {
        subject: 'Custom email',
      },
    }))
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
          return ['slack']
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
          return ['slack']
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
        return ['email', 'slack']
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
      id: ' user-1 ',
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
    notificationsRuntimeInternals.setQueueModuleLoader(undefined)

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
        return ['email']
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
        return ['email']
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
    expect(notificationsRuntimeInternals.resolveNotificationQueueOptions({
      via() {
        return ['email']
      },
      build: {
        email() {
          return {
            subject: 'Hello',
          }
        },
      },
      queue() {
        return undefined as never
      },
    }, {
      index: 0,
      anonymous: false,
      notifiable: {},
    }, 'email')).toBe(false)
    expect(notificationsRuntimeInternals.resolveNotificationQueueOptions({
      via() {
        return ['email']
      },
      build: {
        email() {
          return {
            subject: 'Hello',
          }
        },
      },
      queue() {
        return {
          connection: ' redis ',
          queue: ' notifications ',
          delay: 5,
          afterCommit: true,
        }
      },
    }, {
      index: 0,
      anonymous: false,
      notifiable: {},
    }, 'email')).toEqual({
      connection: 'redis',
      queue: 'notifications',
      delay: 5,
      afterCommit: true,
    })
    expect(() => notificationsRuntimeInternals.resolveNotificationQueueOptions({
      via() {
        return ['email']
      },
      build: {
        email() {
          return {
            subject: 'Hello',
          }
        },
      },
      queue() {
        return {
          afterCommit: 'yes',
        } as never
      },
    }, {
      index: 0,
      anonymous: false,
      notifiable: {},
    }, 'email')).toThrow('Notification queue afterCommit must be a boolean')

    expect(notificationsRuntimeInternals.resolveNotificationDelay({
      via() {
        return ['email']
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
        return ['email']
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
        return ['email']
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
    expect(notificationsRuntimeInternals.resolveNotificationDelay({
      via() {
        return ['email']
      },
      build: {
        email() {
          return {
            subject: 'Hello',
          }
        },
      },
      delay() {
        return undefined
      },
    }, {
      index: 0,
      anonymous: false,
      notifiable: {},
    }, 'email')).toBeUndefined()
    expect(notificationsRuntimeInternals.resolveNotificationDelay({
      via() {
        return ['email']
      },
      build: {
        email() {
          return {
            subject: 'Hello',
          }
        },
      },
      delay() {
        return delayedAt
      },
    }, {
      index: 0,
      anonymous: false,
      notifiable: {},
    }, 'email')).toBe(delayedAt)

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
        return ['email']
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
        return ['email']
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
        return ['email']
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

    configureNotificationsRuntime({
      deferAfterCommit() {
        return false
      },
    })
    await expect(notificationsRuntimeInternals.deferDispatchUntilCommit({
      target: {
        kind: 'notifiable',
        value: { email: 'ava@example.com' },
      },
      notification: {
        via() {
          return ['email']
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
    }, {
      via() {
        return ['email']
      },
      build: {
        email() {
          return {
            subject: 'Hello',
          }
        },
      },
    }, [{
      target: {
        index: 0,
        anonymous: false,
        notifiable: { email: 'ava@example.com' },
      },
      channels: ['email'] as const,
    }])).resolves.toBeNull()

    const finallyDispatch = notify({ id: 'user-1', email: 'ava@example.com' }, invoicePaid)
    await expect(finallyDispatch.finally()).resolves.toMatchObject({
      totalTargets: 1,
    })
  })
})
