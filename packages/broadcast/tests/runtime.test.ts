import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureQueueRuntime, normalizeQueueConfig, resetQueueRegistry, resetQueueRuntime } from '@holo-js/queue'
import { normalizeBroadcastConfig } from '../src'
import {
  broadcast,
  broadcastRaw,
  channel,
  configureBroadcastRuntime,
  defineBroadcast,
  presenceChannel,
  privateChannel,
  loadBroadcastPluginDrivers,
  registerBroadcastDriver,
  resetBroadcastDriverRegistry,
  resetBroadcastRuntime,
} from '../src'

function createConfig() {
  return normalizeBroadcastConfig({
    default: 'reverb',
    connections: {
      reverb: {
        driver: 'holo',
        key: 'reverb-key',
        secret: 'reverb-secret',
        appId: 'reverb-app',
        options: {
          host: 'ws.example.com',
          port: 443,
          scheme: 'https',
        },
      },
      pusher: {
        driver: 'pusher',
        key: 'pusher-key',
        secret: 'pusher-secret',
        appId: 'pusher-app',
        options: {
          host: 'api.pusher.test',
          port: 443,
          scheme: 'https',
        },
      },
      log: {
        driver: 'log',
      },
      null: {
        driver: 'null',
      },
      custom: {
        driver: 'custom',
      },
    },
  })
}

async function writeBroadcastPluginProject(
  projectRoot: string,
  packageName: string,
  driverName: string,
  label: string,
): Promise<void> {
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
    name: `${label}-broadcast-plugin-fixture`,
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
  id: '${label}-broadcast-plugin',
  contributes: {
    broadcast: {
      drivers: {
        ${driverName}: {
          runtime: './driver.mjs',
        },
      },
    },
  },
}
`)
  await writeFile(join(pluginRoot, 'driver.mjs'), `
export default {
  async send() {
    return {
      provider: {
        project: '${label}',
      },
    }
  },
}
`)
}

afterEach(() => {
  resetBroadcastRuntime()
  resetBroadcastDriverRegistry()
  vi.restoreAllMocks()
  resetQueueRegistry()
  resetQueueRuntime()
})

describe('@holo-js/broadcast runtime', () => {
  it('dispatches lazily through built-in transport drivers and raw send path', async () => {
    const publish = vi.fn(async (input, context) => ({
      connection: context.connection,
      driver: context.driver,
      queued: context.queued,
      publishedChannels: input.channels,
      provider: {
        event: input.event,
      },
    }))

    configureBroadcastRuntime({
      config: createConfig(),
      publish,
    })

    const pending = broadcast(defineBroadcast({
      name: 'orders.updated',
      channels: [privateChannel('orders.{orderId}', { orderId: 'ord_1' })],
      payload: {
        orderId: 'ord_1',
      },
    }))

    expect(publish).not.toHaveBeenCalled()

    const result = await pending
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenNthCalledWith(1, {
      connection: 'reverb',
      event: 'orders.updated',
      channels: ['private-orders.ord_1'],
      payload: {
        orderId: 'ord_1',
      },
    }, expect.objectContaining({
      connection: 'reverb',
      driver: 'holo',
      queued: false,
      delayed: false,
    }))
    expect(result).toMatchObject({
      connection: 'reverb',
      driver: 'holo',
      queued: false,
      publishedChannels: ['private-orders.ord_1'],
      provider: {
        event: 'orders.updated',
      },
    })

    const raw = await broadcastRaw({
      connection: 'pusher',
      event: 'orders.shipped',
      channels: ['orders.ord_2'],
      payload: {
        orderId: 'ord_2',
      },
    })

    expect(raw.driver).toBe('pusher')
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('loads broadcast drivers contributed by active Holo plugins', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-broadcast-plugin-'))
    const previousCwd = process.cwd()

    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'broadcast-plugin-fixture',
        private: true,
      }, null, 2))
      await mkdir(join(projectRoot, 'config'), { recursive: true })
      await writeFile(join(projectRoot, 'config/app.mjs'), `
export default {
  plugins: ['holo-plugin-broadcast'],
}
`)
      const pluginRoot = join(projectRoot, 'node_modules/holo-plugin-broadcast')
      await mkdir(pluginRoot, { recursive: true })
      await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
        name: 'holo-plugin-broadcast',
        type: 'module',
        holo: {
          plugin: './plugin.mjs',
        },
      }, null, 2))
      await writeFile(join(pluginRoot, 'plugin.mjs'), `
export default {
  id: 'broadcast-plugin',
  contributes: {
    broadcast: {
      drivers: {
        plugin: {
          runtime: './driver.mjs',
        },
      },
    },
  },
}
`)
      await writeFile(join(pluginRoot, 'driver.mjs'), `
export default {
  async send(input, context) {
    return {
      connection: context.connection,
      driver: context.driver,
      queued: context.queued,
      publishedChannels: input.channels,
    }
  },
}
`)

      configureBroadcastRuntime({
        config: normalizeBroadcastConfig({
          default: 'plugin',
          connections: {
            plugin: {
              driver: 'plugin',
            },
          },
        }),
        projectRoot: ` ${projectRoot} `,
        plugins: ['holo-plugin-broadcast'],
      } as Parameters<typeof configureBroadcastRuntime>[0] & { readonly projectRoot: string })

      await expect(broadcastRaw({
        event: 'plugin.loaded',
        channels: ['plugin.loaded'],
        payload: {
          ok: true,
        },
      })).resolves.toMatchObject({
        connection: 'plugin',
        driver: 'plugin',
        queued: false,
        publishedChannels: ['plugin.loaded'],
      })
      await expect(loadBroadcastPluginDrivers(projectRoot, ['holo-plugin-broadcast'])).resolves.toBeUndefined()
      await expect(loadBroadcastPluginDrivers(projectRoot, ['holo-plugin-broadcast'])).resolves.toBeUndefined()
    } finally {
      process.chdir(previousCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('clears broadcast plugin drivers when the runtime resets', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'holo-broadcast-plugin-first-'))
    const secondRoot = await mkdtemp(join(tmpdir(), 'holo-broadcast-plugin-second-'))

    try {
      await writeBroadcastPluginProject(firstRoot, 'holo-plugin-broadcast-first', 'shared', 'first')
      await writeBroadcastPluginProject(secondRoot, 'holo-plugin-broadcast-second', 'shared', 'second')
      registerBroadcastDriver('shared', {
        async send(input, context) {
          return { ...context, provider: { project: 'previous' }, publishedChannels: input.channels }
        },
      })
      await loadBroadcastPluginDrivers(firstRoot, ['holo-plugin-broadcast-first'])

      configureBroadcastRuntime({
        config: normalizeBroadcastConfig({
          default: 'shared',
          connections: {
            shared: {
              driver: 'shared',
            },
          },
        }),
        projectRoot: firstRoot,
        plugins: ['holo-plugin-broadcast-first'],
      } as Parameters<typeof configureBroadcastRuntime>[0] & { readonly projectRoot: string })

      await expect(broadcastRaw({
        event: 'plugin.first',
        channels: ['plugin.first'],
        payload: {},
      })).resolves.toMatchObject({
        provider: {
          project: 'first',
        },
      })
      await loadBroadcastPluginDrivers(secondRoot, ['holo-plugin-broadcast-second'])

      resetBroadcastRuntime()
      configureBroadcastRuntime({
        config: normalizeBroadcastConfig({
          default: 'shared',
          connections: {
            shared: {
              driver: 'shared',
            },
          },
        }),
        projectRoot: secondRoot,
        plugins: ['holo-plugin-broadcast-second'],
      } as Parameters<typeof configureBroadcastRuntime>[0] & { readonly projectRoot: string })
      await loadBroadcastPluginDrivers(secondRoot, ['holo-plugin-broadcast-second'])

      await expect(broadcastRaw({
        event: 'plugin.second',
        channels: ['plugin.second'],
        payload: {},
      })).resolves.toMatchObject({
        provider: {
          project: 'second',
        },
      })
      registerBroadcastDriver('shared', {
        async send(input, context) {
          return { ...context, provider: { project: 'override' }, publishedChannels: input.channels }
        },
      }, { replace: true })
      resetBroadcastRuntime()
    } finally {
      await rm(firstRoot, { recursive: true, force: true })
      await rm(secondRoot, { recursive: true, force: true })
    }
  })

  it('loads plugin drivers while delivering queued broadcasts', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-broadcast-queued-plugin-'))
    const previousCwd = process.cwd()

    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'broadcast-queued-plugin-fixture',
        private: true,
      }, null, 2))
      await mkdir(join(projectRoot, 'config'), { recursive: true })
      await writeFile(join(projectRoot, 'config/app.mjs'), `
export default {
  plugins: ['holo-plugin-broadcast-queued'],
}
`)
      const pluginRoot = join(projectRoot, 'node_modules/holo-plugin-broadcast-queued')
      await mkdir(pluginRoot, { recursive: true })
      await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
        name: 'holo-plugin-broadcast-queued',
        type: 'module',
        holo: {
          plugin: './plugin.mjs',
        },
      }, null, 2))
      await writeFile(join(pluginRoot, 'plugin.mjs'), `
export default {
  id: 'broadcast-queued-plugin',
  contributes: {
    broadcast: {
      drivers: {
        plugin: {
          runtime: './driver.mjs',
        },
      },
    },
  },
}
`)
      await writeFile(join(pluginRoot, 'driver.mjs'), `
export default {
  async send(input, context) {
    return {
      connection: context.connection,
      driver: context.driver,
      queued: context.queued,
      publishedChannels: input.channels,
    }
  },
}
`)

      configureBroadcastRuntime({
        config: normalizeBroadcastConfig({
          default: 'plugin',
          connections: {
            plugin: {
              driver: 'plugin',
            },
          },
        }),
        projectRoot,
        plugins: ['holo-plugin-broadcast-queued'],
      } as Parameters<typeof configureBroadcastRuntime>[0] & { readonly projectRoot: string })

      configureQueueRuntime({ config: normalizeQueueConfig({ default: 'sync', failed: false }) })
      await expect(broadcastRaw({
        connection: 'plugin',
        event: 'plugin.queued',
        channels: ['plugin.queued'],
        payload: { ok: true },
      }).onConnection('sync')).resolves.toMatchObject({
        connection: 'plugin',
        driver: 'plugin',
        queued: true,
        publishedChannels: ['plugin.queued'],
      })
    } finally {
      process.chdir(previousCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('dispatches built-in drivers when unrelated plugin drivers are broken', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-broadcast-broken-plugin-'))
    const previousCwd = process.cwd()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'broadcast-broken-plugin-fixture',
        private: true,
      }, null, 2))
      await mkdir(join(projectRoot, 'config'), { recursive: true })
      await writeFile(join(projectRoot, 'config/app.mjs'), `
export default {
  plugins: ['holo-plugin-broken-broadcast'],
}
`)
      const pluginRoot = join(projectRoot, 'node_modules/holo-plugin-broken-broadcast')
      await mkdir(pluginRoot, { recursive: true })
      await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
        name: 'holo-plugin-broken-broadcast',
        type: 'module',
        holo: {
          plugin: './plugin.mjs',
        },
      }, null, 2))
      await writeFile(join(pluginRoot, 'plugin.mjs'), `
export default {
  id: 'broken-broadcast-plugin',
  contributes: {
    broadcast: {
      drivers: {
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

      process.chdir(projectRoot)
      configureBroadcastRuntime({
        config: normalizeBroadcastConfig({
          default: 'log',
          connections: {
            log: {
              driver: 'log',
            },
          },
        }),
      })

      await expect(broadcastRaw({
        event: 'built-in.available',
        channels: ['built-in.available'],
        payload: {},
      })).resolves.toMatchObject({
        connection: 'log',
        driver: 'log',
        queued: false,
        publishedChannels: ['built-in.available'],
      })
      expect(warn).toHaveBeenCalledOnce()
      await expect(loadBroadcastPluginDrivers(projectRoot, ['holo-plugin-broken-broadcast'])).rejects.toThrow('must export send()')
      await expect(loadBroadcastPluginDrivers(projectRoot, ['holo-plugin-broken-broadcast'])).rejects.toThrow('must export send()')
    } finally {
      warn.mockRestore()
      process.chdir(previousCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('preserves connection resolution errors when active plugin drivers are broken', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-broadcast-missing-connection-broken-plugin-'))
    const previousCwd = process.cwd()

    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'broadcast-missing-connection-broken-plugin-fixture',
        private: true,
      }, null, 2))
      await mkdir(join(projectRoot, 'config'), { recursive: true })
      await writeFile(join(projectRoot, 'config/app.mjs'), `
export default {
  plugins: ['holo-plugin-broken-broadcast'],
}
`)
      const pluginRoot = join(projectRoot, 'node_modules/holo-plugin-broken-broadcast')
      await mkdir(pluginRoot, { recursive: true })
      await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
        name: 'holo-plugin-broken-broadcast',
        type: 'module',
        holo: {
          plugin: './plugin.mjs',
        },
      }, null, 2))
      await writeFile(join(pluginRoot, 'plugin.mjs'), `
export default {
  id: 'broken-broadcast-plugin',
  contributes: {
    broadcast: {
      drivers: {
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

      process.chdir(projectRoot)
      configureBroadcastRuntime({
        config: normalizeBroadcastConfig({
          default: 'log',
          connections: {
            log: {
              driver: 'log',
            },
          },
        }),
      })

      await expect(broadcastRaw({
        connection: 'missing',
        event: 'connection.missing',
        channels: ['connection.missing'],
        payload: {},
      })).rejects.toThrow('Broadcast connection "missing" is not configured')
    } finally {
      process.chdir(previousCwd)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('rejects non-finite raw broadcast payload numbers', async () => {
    configureBroadcastRuntime({
      config: createConfig(),
      publish: vi.fn(),
    })

    await expect(broadcastRaw({
      event: 'orders.updated',
      channels: ['orders.ord_1'],
      payload: {
        value: Number.POSITIVE_INFINITY,
      },
    })).rejects.toThrow('JSON-serializable')
  })

  it('dispatches presence channel definitions with the presence- prefix', async () => {
    const publish = vi.fn(async (input, context) => ({
      connection: context.connection,
      driver: context.driver,
      queued: context.queued,
      publishedChannels: input.channels,
    }))

    configureBroadcastRuntime({
      config: createConfig(),
      publish,
    })

    const result = await broadcast(defineBroadcast({
      name: 'chat.joined',
      channels: [presenceChannel('chat.{roomId}', { roomId: 'room_1' })],
      payload: { userId: 'user_1' },
    }))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenNthCalledWith(1, {
      connection: 'reverb',
      event: 'chat.joined',
      channels: ['presence-chat.room_1'],
      payload: { userId: 'user_1' },
    }, expect.objectContaining({
      connection: 'reverb',
      driver: 'holo',
    }))
    expect(result).toMatchObject({
      publishedChannels: ['presence-chat.room_1'],
    })
  })

  it('supports custom drivers, built-in log/null drivers, and immutable inputs/results', async () => {
    const send = vi.fn((input, context) => {
      expect(Object.isFrozen(input)).toBe(true)
      expect(Object.isFrozen(input.channels)).toBe(true)
      expect(Object.isFrozen(input.payload)).toBe(true)
      expect(Object.isFrozen(context)).toBe(true)
      expect(input.socketId).toBe('socket-1')

      return {
        connection: ` ${context.connection} `,
        driver: ` ${context.driver} `,
        queued: false,
        publishedChannels: input.channels,
        messageId: 'custom-msg',
        provider: {
          ok: true,
        },
      }
    })

    registerBroadcastDriver('custom', { send })
    const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    configureBroadcastRuntime({
      config: createConfig(),
    })

    const custom = await broadcastRaw({
      connection: 'custom',
      event: 'orders.updated',
      channels: ['orders.1'],
      payload: {
        ok: true,
      },
      socketId: 'socket-1',
    })

    const logged = await broadcastRaw({
      connection: 'log',
      event: 'orders.logged',
      channels: ['orders.2'],
      payload: {
        ok: true,
      },
    })

    const nulled = await broadcastRaw({
      connection: 'null',
      event: 'orders.ignored',
      channels: ['orders.3'],
      payload: {
        ok: true,
      },
    })

    expect(send).toHaveBeenCalledTimes(1)
    expect(custom).toMatchObject({
      connection: 'custom',
      driver: 'custom',
      queued: false,
      publishedChannels: ['orders.1'],
      messageId: 'custom-msg',
      provider: {
        ok: true,
      },
    })
    expect(Object.isFrozen(custom)).toBe(true)
    expect(Object.isFrozen(custom.provider)).toBe(true)
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logged.driver).toBe('log')
    expect(nulled.driver).toBe('null')

    await expect(broadcastRaw({
      event: 'orders.bad',
      channels: [],
      payload: {
        ok: true,
      },
    })).rejects.toThrow('at least one channel')
  })

  it('executes one queued delivery when the same pending broadcast is awaited concurrently', async () => {
    configureQueueRuntime({ config: normalizeQueueConfig({ default: 'sync', failed: false }) })
    const deliveries: string[] = []
    registerBroadcastDriver('custom', {
      async send(input, context) {
        deliveries.push(input.event)
        return { connection: context.connection, driver: context.driver, queued: context.queued, publishedChannels: input.channels }
      },
    })
    configureBroadcastRuntime({ config: createConfig() })
    const pending = broadcast({
      name: 'orders.queued',
      channels: [channel('orders')],
      payload: { id: 1 },
      queue: true,
    }).using('custom')
    const [first, second] = await Promise.all([pending, pending])
    expect(first).toBe(second)
    expect(first).toMatchObject({ queued: true, publishedChannels: ['orders'] })
    expect(deliveries).toEqual(['orders.queued'])
  })

  it('rejects invalid sends through the public pending broadcast interface', async () => {
    configureBroadcastRuntime({ config: createConfig() })
    const input = { connection: 'null', event: 'orders.updated', channels: ['orders'], payload: { id: 1 } }
    await expect(broadcastRaw({ ...input, event: ' ' })).rejects.toThrow('non-empty string')
    await expect(broadcastRaw({ ...input, connection: 'missing' })).rejects.toThrow('is not configured')
    await expect(broadcastRaw({ ...input, connection: 'custom' })).rejects.toThrow('is not registered')
    await expect(broadcastRaw({ ...input, connection: 'reverb' })).rejects.toThrow('requires a publish runtime binding')
    await expect(broadcastRaw({ ...input, socketId: ' ' })).rejects.toThrow('non-empty string')
    await expect(broadcastRaw({ ...input, payload: { invalid: new Map() } } as never)).rejects.toThrow('JSON-serializable')
    expect(() => broadcastRaw(input).delay(-1)).toThrow('greater than or equal to 0')
    expect(() => broadcastRaw(input).delay(new Date('invalid'))).toThrow('valid Date')
    expect(() => broadcastRaw(input).using(' ')).toThrow('non-empty string')
    await expect(broadcast({ channels: [channel('orders')], payload: { id: 1 } })).rejects.toThrow('public event name')
  })
})
