import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureNotificationsRuntime,
  defineNotification,
  getRegisteredNotificationChannel,
  listRegisteredNotificationChannels,
  loadNotificationPluginChannels,
  notify,
  notifyUsing,
  registerNotificationChannel,
  resetNotificationChannelRegistry,
  resetNotificationsRuntime,
  type NotificationChannel,
} from '../src'

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

afterEach(() => {
  resetNotificationsRuntime()
  resetNotificationChannelRegistry()
})

describe('@holo-js/notifications runtime', () => {

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
        .notify(defineNotification({
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
        .notify(defineNotification({
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
        .notify(defineNotification({
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
        .notify(defineNotification({
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
})
